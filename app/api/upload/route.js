import { NextResponse } from 'next/server';
import { Storage } from '@google-cloud/storage';

const PROJECT_ID  = process.env.GCP_PROJECT_ID;
const BUCKET_NAME = process.env.GCS_BUCKET_NAME;

// WIF config — keyless GCP auth (no SA key needed)
const WIF_STS_AUDIENCE =
  `//iam.googleapis.com/projects/61278613673/locations/global/` +
  `workloadIdentityPools/vercel-pool/providers/vercel-provider`;
const VERCEL_OIDC_AUDIENCE = 'https://vercel.com/aryan-sonawanes-projects';
const SA_EMAIL = 'gcp-ai-pipeline-sa@gcp-ai-pipeline-515018.iam.gserviceaccount.com';

/**
 * Exchange Vercel's OIDC token for a GCP access token via WIF.
 * No SA key required — works despite org policy restrictions.
 */
async function getGcpAccessToken() {
  const { getVercelOidcToken } = await import('@vercel/oidc');

  // 1. Vercel OIDC JWT
  const oidcToken = await getVercelOidcToken(VERCEL_OIDC_AUDIENCE);

  // 2. STS token exchange → federated access token
  const stsRes = await fetch('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: WIF_STS_AUDIENCE,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      subjectToken: oidcToken,
      subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token',
    }),
  });
  const stsBody = await stsRes.json();
  if (!stsRes.ok) throw new Error(`STS exchange failed: ${JSON.stringify(stsBody)}`);

  // 3. Impersonate service account → scoped access token
  const iamRes = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA_EMAIL}:generateAccessToken`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stsBody.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/devstorage.read_write'] }),
    }
  );
  const iamBody = await iamRes.json();
  if (!iamRes.ok) throw new Error(`SA impersonation failed: ${JSON.stringify(iamBody)}`);

  return iamBody.accessToken;
}

export async function POST(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ error: 'Invalid file type' }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const safeFileName = `uploads/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    if (process.env.VERCEL) {
      // ── Vercel: keyless WIF auth → direct GCS JSON API call ──────────────
      const accessToken = await getGcpAccessToken();
      const uploadUrl =
        `https://storage.googleapis.com/upload/storage/v1/b/` +
        `${BUCKET_NAME}/o?uploadType=media&name=${encodeURIComponent(safeFileName)}`;

      const gcsRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': file.type,
        },
        body: buffer,
      });

      if (!gcsRes.ok) {
        const errBody = await gcsRes.text();
        throw new Error(`GCS upload failed (${gcsRes.status}): ${errBody}`);
      }
    } else {
      // ── Local: try ADC first; fallback to gcloud print-access-token ──────
      let uploaded = false;
      try {
        const storage = new Storage({ projectId: PROJECT_ID });
        await storage.bucket(BUCKET_NAME).file(safeFileName).save(buffer, {
          contentType: file.type,
          resumable: false,
        });
        uploaded = true;
      } catch (adcErr) {
        console.warn('[upload] ADC not present, falling back to local gcloud auth token');
      }

      if (!uploaded) {
        const { execSync } = await import('child_process');
        const token = execSync('gcloud auth print-access-token').toString().trim();
        const uploadUrl =
          `https://storage.googleapis.com/upload/storage/v1/b/` +
          `${BUCKET_NAME}/o?uploadType=media&name=${encodeURIComponent(safeFileName)}`;

        const gcsRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': file.type,
          },
          body: buffer,
        });

        if (!gcsRes.ok) {
          const errBody = await gcsRes.text();
          throw new Error(`GCS upload failed (${gcsRes.status}): ${errBody}`);
        }
      }
    }

    return NextResponse.json({ success: true, fileName: safeFileName });
  } catch (err) {
    console.error('[upload] Error:', err.message);
    return NextResponse.json({ error: 'Upload failed: ' + err.message }, { status: 500 });
  }
}
