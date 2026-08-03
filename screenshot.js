#!/usr/bin/env node
// Usage: node screenshot.js <url> [output.png] [width] [height] [delay_ms]
// Example: node screenshot.js "http://localhost:3001/story.html" out.png 1440 900 2000

const puppeteer = require('puppeteer');
const path = require('path');

const url     = process.argv[2] || 'http://localhost:3001';
const outFile = process.argv[3] || path.join(__dirname, 'screenshot-preview.png');
const width   = parseInt(process.argv[4]) || 1440;
const height  = parseInt(process.argv[5]) || 900;
const delay   = parseInt(process.argv[6]) || 1500;

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
  } catch (e) {
    // timeout is fine — page may still be useful
  }

  // Extra wait for JS-rendered UI
  await new Promise(r => setTimeout(r, delay));

  await page.screenshot({ path: outFile, fullPage: false });
  await browser.close();

  console.log('SCREENSHOT_PATH:' + outFile);
})();
