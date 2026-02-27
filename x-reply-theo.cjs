const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];

  console.log("=== Replying to @theo ===");
  await page.goto("https://x.com/theo/status/2025465484028870674");
  await page.waitForTimeout(5000);
  
  // Scroll a bit like reading the thread
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(2000 + Math.random() * 2000);
  
  // Click reply box
  const replyBox = await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
  await replyBox.click();
  await page.waitForTimeout(1000);
  
  const comment = `if by "ship" you mean mass distribute then yeah most devs have no idea how to do that lol

non-technical people learned to vibe code in 6 months. now technical people need to learn marketing in 6 months. everyone's learning each other's job and nobody's good at either yet

it's a blender out here`;
  
  await page.keyboard.type(comment, { delay: 18 + Math.random() * 12 });
  await page.waitForTimeout(1500);
  
  const replyBtn = await page.waitForSelector('[data-testid="tweetButtonInline"]', { timeout: 5000 });
  await replyBtn.click();
  await page.waitForTimeout(4000);
  
  console.log("Reply posted!");
  
  await browser.close();
})().catch(e => console.error("ERROR:", e.message));
