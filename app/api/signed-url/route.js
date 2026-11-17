import { NextResponse } from 'next/server';

const PROJECT_ID   = process.env.GCP_PROJECT_ID;
const BUCKET_NAME  = process.env.GCS_BUCKET_NAME;
const SA_EMAIL     = 'gcp-ai-pipeline-sa@gcp-ai-pipeline-515018.iam.gserviceaccount.com';
// WIF audience — matches the pool/provider created in GCP
const WIF_AUDIENCE =
  'identitynamespace:61278613673.svc.id.goog:https://iam.googleapis.com/' +
  'projects/61278613673/locations/global/workloadIdentityPools/vercel-pool/providers/vercel-provider';

const SIGNED_URL_EXPIRY_SECONDS = 600; // 10 minutes

/**
 * Exchange Vercel's built-in OIDC token for a GCP access token
 * via Workload Identity Federation — no SA JSON key required.
 */
async function getGcpTokenViaWIF() {
  // 1. Fetch Vercel's OIDC id-token for GCP
  const oidcRes = await fetch(
    `https://vercel.com/_oidc?audience=${encodeURIComponent(WIF_AUDIENCE)}`,
    { headers: { Authorization: `Bearer ${process.env.VERCEL_OIDC_TOKEN}` } }
  );
  if (!oidcRes.ok) {
    const body = await oidcRes.text();
    throw new Error(`OIDC token fetch failed (${oidcRes.status}): ${body}`);
  }
  const { value: oidcToken } = await oidcRes.json();

  // 2. Exchange the OIDC token for a federated GCP access token (STS)
  const stsRes = await fetch('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: `//iam.googleapis.com/projects/61278613673/locations/global/workloadIdentityPools/vercel-pool/providers/vercel-provider`,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      subjectToken: oidcToken,
      subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token',
    }),
  });
  if (!stsRes.ok) {
    const body = await stsRes.text();
    throw new Error(`STS exchange failed (${stsRes.status}): ${body}`);
  }
  const { access_token: federatedToken } = await stsRes.json();

  // 3. Use IAM to impersonate the service account → get a scoped access token
  const iamRes = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA_EMAIL}:generateAccessToken`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${federatedToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        scope: ['https://www.googleapis.com/auth/devstorage.read_write'],
      }),
    }
  );
  if (!iamRes.ok) {
    const body = await iamRes.text();
    throw new Error(`SA impersonation failed (${iamRes.status}): ${body}`);
  }
  const { accessToken } = await iamRes.json();
  return accessToken;
}

/**
 * Sign a GCS URL using the IAM signBlob API (no local private key needed).
 * Works with both ADC (local) and WIF (Vercel) access tokens.
 */
async function buildSignedUrl(accessToken, safeFileName, contentType) {
  const expiry = Math.floor(Date.now() / 1000) + SIGNED_URL_EXPIRY_SECONDS;
  const host = `${BUCKET_NAME}.storage.googleapis.com`;
  const resource = `/${safeFileName}`;

  // Build the string to sign (V4 canonical request would be ideal, but
  // signBlob via IAM only works with V2 or we pre-sign manually.
  // Easiest: generate a V2 signed URL using the IAM signBlob endpoint.)
  const stringToSign = [
    'PUT',
    '',                // MD5 (empty)
    contentType,
    expiry,
    resource,
  ].join('\n');

  // Sign using IAM credentials API
  const signRes = await fetch(
    `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${SA_EMAIL}:signBlob`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payload: Buffer.from(stringToSign).toString('base64') }),
    }
  );
  if (!signRes.ok) {
    const body = await signRes.text();
    throw new Error(`signBlob failed (${signRes.status}): ${body}`);
  }
  const { signedBlob } = await signRes.json();
  const signature = encodeURIComponent(signedBlob);

  const url =
    `https://storage.googleapis.com/${BUCKET_NAME}/${safeFileName}` +
    `?X-Goog-Algorithm=GOOG4-RSA-SHA256` +
    // For V2 compat we keep it simple; use query-param style
    `&GoogleAccessId=${encodeURIComponent(SA_EMAIL)}` +
    `&Expires=${expiry}` +
    `&Signature=${signature}`;

  // Actually, use proper V2 URL format:
  const v2Url =
    `https://storage.googleapis.com/${BUCKET_NAME}/${safeFileName}` +
    `?GoogleAccessId=${encodeURIComponent(SA_EMAIL)}` +
    `&Expires=${expiry}` +
    `&Signature=${signature}`;

  return v2Url;
}

export async function POST(request) {
  try {
    const { fileName, fileType } = await request.json();

    if (!fileName || !fileType) {
      return NextResponse.json(
        { error: 'fileName and fileType are required' },
        { status: 400 }
      );
    }

    // Sanitize filename
    const safeFileName = `uploads/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    let signedUrl;

    if (process.env.VERCEL) {
      // ── Vercel: keyless WIF auth ───────────────────────────────────────────
      const accessToken = await getGcpTokenViaWIF();
      signedUrl = await buildSignedUrl(accessToken, safeFileName, fileType);
    } else {
      // ── Local: use @google-cloud/storage with ADC ──────────────────────────
      const { Storage } = await import('@google-cloud/storage');
      const storage = new Storage({ projectId: PROJECT_ID });
      const [url] = await storage
        .bucket(BUCKET_NAME)
        .file(safeFileName)
        .generateSignedUrl({
          version: 'v4',
          action: 'write',
          expires: Date.now() + SIGNED_URL_EXPIRY_SECONDS * 1000,
          contentType: fileType,
        });
      signedUrl = url;
    }

    return NextResponse.json({ signedUrl, safeFileName });
  } catch (err) {
    console.error('[signed-url] Error generating signed URL:', err.message);
    return NextResponse.json(
      { error: 'Failed to generate upload URL' },
      { status: 500 }
    );
  }
}
