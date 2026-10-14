'use strict';

/**
 * Returns a Gemini-ready inline document descriptor from a file buffer.
 * No text extraction — the raw bytes are sent directly to the model.
 *
 * @param {Buffer} buffer        - Raw file buffer from multer memoryStorage
 * @param {string} mimetype      - MIME type reported by the upload
 * @param {string} originalname  - Original filename (used to infer MIME if needed)
 * @returns {{ mimeType: string, data: string, originalname: string }}
 */
function prepareDocument(buffer, mimetype, originalname) {
  const name = (originalname || '').toLowerCase();

  // Normalise MIME type
  let mimeType = mimetype;
  if (!mimeType || mimeType === 'application/octet-stream') {
    if (name.endsWith('.pdf'))  mimeType = 'application/pdf';
    else if (name.endsWith('.docx')) mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    else if (name.endsWith('.xlsx')) mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    else if (name.endsWith('.txt'))  mimeType = 'text/plain';
    else mimeType = 'application/pdf'; // safe fallback
  }

  return {
    mimeType,
    data:         buffer.toString('base64'),
    originalname: originalname || 'document'
  };
}

module.exports = { prepareDocument };
