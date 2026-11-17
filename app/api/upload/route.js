import { NextResponse } from 'next/server';
import { Storage } from '@google-cloud/storage';

const PROJECT_ID  = process.env.GCP_PROJECT_ID;
const BUCKET_NAME = process.env.GCS_BUCKET_NAME;

// WIF config — keyless auth for Vercel (no SA key needed)
// STS audience: the full WIF provider resource path
const WIF_STS_AUDIENCE =
  `//iam.googleapis.com/projects/61278613673/locations/global/` +
  `workloadIdentityPools/vercel-pool/providers/vercel-provider`;
// OIDC audience: what Vercel actually puts in the token
const VERCEL_OIDC_AUDIENCE = 'https://vercel.com/aryan-sonawanes-projects';
const SA_EMAIL =
  'gcp-ai-pipeline-sa@gcp-ai-pipeline-515018.iam.gserviceaccount.com';

async function getGcpAccessToken() {
  const { getVercelOidcToken } = await import('@vercel/oidc');

  // 1. Get Vercel OIDC token
  const oidcToken = await getVercelOidcToken(VERCEL_OIDC_AUDIENCE);
  console.log('[upload] Got OIDC token, length:', oidcToken?.length);

  // 2. Exchange for a federated GCP access token via STS
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
  if (!stsRes.ok) throw new Error(`STS exchange failed (${stsRes.status}): ${JSON.stringify(stsBody)}`);
  console.log('[upload] STS exchange OK');

  // 3. Impersonate the service account to get a scoped access token
  const iamRes = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA_EMAIL}:generateAccessToken`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stsBody.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        scope: ['https://www.googleapis.com/auth/devstorage.read_write'],
      }),
    }
  );
  const iamBody = await iamRes.json();
  if (!iamRes.ok) throw new Error(`SA impersonation failed (${iamRes.status}): ${JSON.stringify(iamBody)}`);
  console.log('[upload] SA impersonation OK');

  return iamBody.accessToken;
}

async function getStorage() {
  if (process.env.VERCEL) {
    // Manual WIF flow — explicit and debuggable
    const accessToken = await getGcpAccessToken();

    // Build a minimal auth client that returns our access token
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      credentials: { type: 'authorized_user' },
    });
    // Override the getAccessToken method on a plain client
    const authClient = await auth.fromJSON({ type: 'authorized_user', client_id: 'x', client_secret: 'x', refresh_token: 'x' }).catch(() => null);

    // Simplest approach: use the Storage JSON API directly with fetch
    return { accessToken, useDirectApi: true };
  }
  // Local dev: uses Application Default Credentials
  return { storage: new Storage({ projectId: PROJECT_ID }), useDirectApi: false };
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

    const ctx = await getStorage();

    if (ctx.useDirectApi) {
      // Use the GCS JSON API directly with our access token
      const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET_NAME}/o?uploadType=media&name=${encodeURIComponent(safeFileName)}`;
      const gcsRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          'Content-Type': file.type,
          'Content-Length': String(buffer.length),
        },
        body: buffer,
      });
      if (!gcsRes.ok) {
        const errBody = await gcsRes.text();
        throw new Error(`GCS upload failed (${gcsRes.status}): ${errBody}`);
      }
      console.log('[upload] File uploaded to GCS:', safeFileName);
    } else {
      await ctx.storage.bucket(BUCKET_NAME).file(safeFileName).save(buffer, {
        contentType: file.type,
        resumable: false,
      });
    }

    return NextResponse.json({ success: true, fileName: safeFileName });
  } catch (err) {
    console.error('[upload] Error:', err.message);
    return NextResponse.json({ error: 'Upload failed: ' + err.message }, { status: 500 });
  }
}
