const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const page = await browser.newPage();
  
  const htmlPath = '/tmp/preventivo-ediltech.html';
  const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
  
  await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
  
  const outputPath = '/home/alessio/dev/oss/polpo/.polpo/output/4_A-8Ivtfd9o3_zuDkOfJ/preventivo-test-ediltech.pdf';
  
  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  
  console.log('PDF generated at:', outputPath);
  
  const stats = fs.statSync(outputPath);
  console.log('File size:', stats.size, 'bytes');
  
  await browser.close();
})();
