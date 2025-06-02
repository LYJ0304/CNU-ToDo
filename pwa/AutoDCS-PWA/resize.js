// resize.js
const sharp = require('sharp');

async function createIcons() {
  try {
    // 152x152
    await sharp('original.png')
      .resize(152, 152)
      .toFile('icon-152.png');
    console.log('icon-152.png created.');

    // 192x192
    await sharp('original.png')
      .resize(192, 192)
      .toFile('icon-192.png');
    console.log('icon-192.png created.');

    // 512x512
    await sharp('original.png')
      .resize(512, 512)
      .toFile('icon-512.png');
    console.log('icon-512.png created.');
    
  } catch (err) {
    console.error('이미지 리사이징 중 오류 발생:', err);
  }
}

createIcons();