// Decodes one HEIC/HEIF file to RGBA in a worker thread. photo-service.js
// starts a fresh worker per file and ends it afterwards, so libheif's WASM
// memory (which never shrinks) is handed back to the OS after every decode.
const { parentPort, workerData } = require('worker_threads');
const libheif = require('libheif-js');

const { buffer, maxPixels } = workerData;

function decode() {
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(new Uint8Array(buffer));
  if (!images.length) return Promise.resolve({ error: 'empty' });

  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  if (!width || !height || width * height > maxPixels) {
    return Promise.resolve({ error: 'too-large' });
  }
  return new Promise((resolve) => {
    image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (result) => {
      resolve(result ? { width, height, pixels: result.data.buffer } : { error: 'unreadable' });
    });
  });
}

decode()
  .then((message) => parentPort.postMessage(message, message.pixels ? [message.pixels] : []))
  .catch(() => parentPort.postMessage({ error: 'unreadable' }));
