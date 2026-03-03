const puppeteer = require('puppeteer');

(async () => {
  const outputPath = '/home/alessio/dev/oss/polpo/.polpo/output/IOERemYVxrJl28ACInGxI/insurtechsolutions-fullpage.png';
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
  
  console.log('Navigating to insurtechsolutions.it...');
  await page.goto('https://insurtechsolutions.it', { waitUntil: 'networkidle2', timeout: 30000 });
  
  // Wait 3 seconds after load
  console.log('Page loaded, waiting 3 seconds...');
  await new Promise(r => setTimeout(r, 3000));
  
  // Slowly scroll to bottom to trigger lazy loading
  console.log('Scrolling down to trigger lazy loading...');
  await page.evaluate(async () => {
    const totalHeight = document.body.scrollHeight;
    const step = 300;
    let current = 0;
    while (current < totalHeight) {
      window.scrollBy(0, step);
      current += step;
      await new Promise(r => setTimeout(r, 100));
    }
    window.scrollTo(0, document.body.scrollHeight);
  });
  
  // Wait 2 seconds at bottom
  console.log('At bottom, waiting 2 seconds...');
  await new Promise(r => setTimeout(r, 2000));
  
  // Scroll back to top
  console.log('Scrolling back to top...');
  await page.evaluate(() => window.scrollTo(0, 0));
  
  // Wait 2 seconds at top
  console.log('At top, waiting 2 seconds...');
  await new Promise(r => setTimeout(r, 2000));
  
  // Take full-page screenshot
  console.log('Taking full-page screenshot...');
  await page.screenshot({
    path: outputPath,
    fullPage: true,
    type: 'png'
  });
  
  const fs = require('fs');
  const stats = fs.statSync(outputPath);
  console.log(`Screenshot saved: ${outputPath}`);
  console.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  
  await browser.close();
  console.log('Done!');
})();
