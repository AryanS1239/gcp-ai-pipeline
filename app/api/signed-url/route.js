import { NextResponse } from 'next/server';
import { Storage } from '@google-cloud/storage';

const PROJECT_ID  = process.env.GCP_PROJECT_ID;
const BUCKET_NAME = process.env.GCS_BUCKET_NAME;
const SIGNED_URL_EXPIRY_SECONDS = 600; // 10 minutes

// WIF configuration (matches the pool/provider created in GCP)
const WIF_AUDIENCE =
  `//iam.googleapis.com/projects/61278613673/locations/global/` +
  `workloadIdentityPools/vercel-pool/providers/vercel-provider`;
const SA_EMAIL = 'gcp-ai-pipeline-sa@gcp-ai-pipeline-515018.iam.gserviceaccount.com';

/**
 * Build a GCP ExternalAccountClient using Vercel's OIDC token.
 * Uses @vercel/oidc + google-auth-library — the official supported pattern.
 */
async function getWifStorage() {
  const { getVercelOidcToken } = await import('@vercel/oidc');
  const { ExternalAccountClient } = await import('google-auth-library');

  const authClient = ExternalAccountClient.fromJSON({
    type: 'external_account',
    audience: WIF_AUDIENCE,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA_EMAIL}:generateAccessToken`,
    subject_token_supplier: {
      getSubjectToken: () => getVercelOidcToken(WIF_AUDIENCE),
    },
  });

  return new Storage({ projectId: PROJECT_ID, authClient });
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

    // Sanitize filename: no path traversal, timestamp prefix
    const safeFileName = `uploads/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    // Choose auth: WIF on Vercel, ADC locally
    const storage = process.env.VERCEL
      ? await getWifStorage()
      : new Storage({ projectId: PROJECT_ID });

    const [signedUrl] = await storage
      .bucket(BUCKET_NAME)
      .file(safeFileName)
      .generateSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + SIGNED_URL_EXPIRY_SECONDS * 1000,
        contentType: fileType,
      });

    return NextResponse.json({ signedUrl, safeFileName });
  } catch (err) {
    console.error('[signed-url] Error:', err.message);
    return NextResponse.json(
      { error: 'Failed to generate upload URL' },
      { status: 500 }
    );
  }
}
