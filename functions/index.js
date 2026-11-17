'use strict';

const vision = require('@google-cloud/vision');
const { createClient } = require('@supabase/supabase-js');

// Initialize clients once (outside handler for cold-start efficiency)
const visionClient = new vision.ImageAnnotatorClient();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * Cloud Function triggered by a GCS object finalize event.
 * Performs OCR + label detection via Vision API, then writes results to Supabase.
 *
 * @param {object} cloudEvent - The CloudEvent from Eventarc
 */
exports.processImage = async (cloudEvent) => {
  // Log the full event structure so we can debug if data shape changes
  console.log('[processImage] cloudEvent type:', cloudEvent?.type);
  console.log('[processImage] cloudEvent data keys:', Object.keys(cloudEvent?.data || {}));

  // GCS Eventarc CloudEvents: data is a StorageObjectData proto
  // Some frameworks put it directly on cloudEvent.data, others nest it
  const data = cloudEvent.data ?? cloudEvent;

  const bucketName = data.bucket ?? data.bucketId ?? process.env.GCS_BUCKET_NAME;
  const fileName   = data.name   ?? data.objectId ?? data.id;
  const contentType = data.contentType ?? data.content_type ?? '';

  if (!bucketName || !fileName) {
    console.error('[processImage] Missing bucket or file name. Full event:', JSON.stringify(cloudEvent));
    throw new Error('Could not extract bucket/fileName from event');
  }

  console.log(`[processImage] Triggered for gs://${bucketName}/${fileName}`);
  console.log(`[processImage] Content-Type: ${contentType}`);

  // Only process image files
  if (!contentType.startsWith('image/')) {
    console.log(`[processImage] Skipping non-image file: ${contentType}`);
    return;
  }

  const gcsUri   = `gs://${bucketName}/${fileName}`;
  const imageUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;

  try {
    // --- Step 1: Run Vision API (OCR + Label Detection in parallel) ---
    console.log(`[processImage] Calling Vision API for: ${gcsUri}`);

    const [annotateResult] = await visionClient.annotateImage({
      image: { source: { imageUri: gcsUri } },
      features: [
        { type: 'TEXT_DETECTION' },
        { type: 'LABEL_DETECTION', maxResults: 10 },
      ],
    });

    // Extract full text
    const extractedText =
      annotateResult.fullTextAnnotation?.text ||
      annotateResult.textAnnotations?.[0]?.description ||
      null;

    // Extract labels as array of { description, score }
    const labels = (annotateResult.labelAnnotations || []).map((label) => ({
      description: label.description,
      score: Math.round(label.score * 100) / 100,
    }));

    console.log(`[processImage] OCR text length: ${extractedText?.length ?? 0} chars`);
    console.log(`[processImage] Labels detected: ${labels.map((l) => l.description).join(', ')}`);

    // --- Step 2: Write to Supabase ---
    console.log(`[processImage] Writing results to Supabase...`);

    const { error } = await supabase.from('image_results').insert({
      image_url: imageUrl,
      extracted_text: extractedText,
      labels: labels,
    });

    if (error) {
      console.error(`[processImage] Supabase insert error:`, JSON.stringify(error));
      throw new Error(`Supabase insert failed: ${error.message}`);
    }

    console.log(`[processImage] ✅ Successfully processed and saved: ${fileName}`);
  } catch (err) {
    console.error(`[processImage] ❌ Fatal error processing ${fileName}:`, err.message);
    throw err;
  }
};
