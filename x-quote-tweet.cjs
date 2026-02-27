const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];
  
  console.log("=== Quote tweeting @simonw ===");
  await page.goto("https://x.com/simonw/status/2025990408514523517");
  await page.waitForTimeout(4000);
  
  // Click retweet button
  const retweetBtn = await page.waitForSelector('[data-testid="retweet"]', { timeout: 5000 });
  await retweetBtn.click();
  await page.waitForTimeout(1500);
  
  // Find and click Quote option using evaluate
  const clicked = await page.evaluate(() => {
    const items = document.querySelectorAll('[role="menuitem"]');
    for (const item of items) {
      const text = item.innerText.toLowerCase();
      console.log("Menu: " + text);
      if (text.includes("quote")) {
        item.click();
        return "clicked quote";
      }
    }
    return "not found - items: " + items.length;
  });
  console.log("Quote menu: " + clicked);
  
  await page.waitForTimeout(2500);
  
  const quoteText = `been building an agent orchestrator for months and the number one thing i wish someone told me earlier: you need a real state machine underneath everything. not vibes, not retry loops, actual state transitions with crash recovery.

the other thing nobody talks about is multi-LLM review. one model checking another model's code barely helps. three models with majority voting is where it actually starts working. "agentic engineering" is 20% prompt craft and 80% infrastructure nobody wants to build`;
  
  const tweetBox = await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 5000 });
  await tweetBox.click();
  await page.waitForTimeout(500);
  await page.keyboard.type(quoteText, { delay: 12 });
  await page.waitForTimeout(1500);
  
  const postBtn = await page.waitForSelector('[data-testid="tweetButton"]', { timeout: 5000 });
  await postBtn.click();
  await page.waitForTimeout(3000);
  
  console.log("Quote tweet posted!");
  
  await browser.close();
})().catch(e => console.error("ERROR:", e.message));
