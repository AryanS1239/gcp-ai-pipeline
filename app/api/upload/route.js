import { NextResponse } from 'next/server';
import { Storage } from '@google-cloud/storage';

const PROJECT_ID  = process.env.GCP_PROJECT_ID;
const BUCKET_NAME = process.env.GCS_BUCKET_NAME;

// WIF config — keyless auth for Vercel (no SA key needed)
// STS audience: the full WIF provider resource path
const WIF_STS_AUDIENCE =
  `//iam.googleapis.com/projects/61278613673/locations/global/` +
  `workloadIdentityPools/vercel-pool/providers/vercel-provider`;
// OIDC audience: what Vercel actually puts in the token (must match allowed-audiences on the provider)
const VERCEL_OIDC_AUDIENCE = 'https://vercel.com/aryan-sonawanes-projects';
const SA_EMAIL =
  'gcp-ai-pipeline-sa@gcp-ai-pipeline-515018.iam.gserviceaccount.com';

async function getStorage() {
  if (process.env.VERCEL) {
    const { getVercelOidcToken } = await import('@vercel/oidc');
    const { ExternalAccountClient } = await import('google-auth-library');

    const authClient = ExternalAccountClient.fromJSON({
      type: 'external_account',
      audience: WIF_STS_AUDIENCE,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      service_account_impersonation_url:
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA_EMAIL}:generateAccessToken`,
      subject_token_supplier: {
        // Pass the team-scoped audience that Vercel will embed in the OIDC token
        getSubjectToken: () => getVercelOidcToken(VERCEL_OIDC_AUDIENCE),
      },
    });

    return new Storage({ projectId: PROJECT_ID, authClient });
  }
  // Local dev: uses Application Default Credentials
  return new Storage({ projectId: PROJECT_ID });
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

    // Read file bytes
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Sanitize filename
    const safeFileName = `uploads/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    const storage = await getStorage();

    // Write directly to GCS — no signing needed, just an authenticated PUT
    await storage.bucket(BUCKET_NAME).file(safeFileName).save(buffer, {
      contentType: file.type,
      resumable: false,
    });

    return NextResponse.json({ success: true, fileName: safeFileName });
  } catch (err) {
    console.error('[upload] Error:', err.message);
    return NextResponse.json({ error: 'Upload failed: ' + err.message }, { status: 500 });
  }
}
