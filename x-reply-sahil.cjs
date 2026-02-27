const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];

  // Find the post
  await page.goto('https://x.com/search?q=from%3Asahill_og%20%2210k%22%20%221%20year%22&f=top');
  await page.waitForTimeout(4000);
  
  const tweet = await page.evaluate(() => {
    const article = document.querySelector("article");
    if (!article) return null;
    const textEl = article.querySelector('[data-testid="tweetText"]');
    let url = "";
    article.querySelectorAll('a[href*="/status/"]').forEach(l => {
      const href = l.getAttribute("href");
      if (href && href.match(/\/status\/\d+$/)) url = href;
    });
    const groups = article.querySelectorAll('[role="group"] button');
    const metrics = [];
    groups.forEach(btn => {
      const aria = btn.getAttribute("aria-label");
      if (aria) metrics.push(aria);
    });
    return {
      text: textEl ? textEl.innerText : "",
      url: url,
      metrics: metrics.join(" | "),
    };
  });
  
  if (tweet) {
    console.log("Found: " + tweet.text.substring(0, 200));
    console.log("URL: https://x.com" + tweet.url);
    console.log("Metrics: " + tweet.metrics);
    
    // Navigate to the actual post
    await page.goto("https://x.com" + tweet.url);
    await page.waitForTimeout(4000);
    
    // Read a bit
    await page.evaluate(() => window.scrollBy(0, 300));
    await page.waitForTimeout(2000 + Math.random() * 2000);
    
    // Reply
    const replyBox = await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
    await replyBox.click();
    await page.waitForTimeout(1000);
    
    const comment = `no. not enough monitors`;
    
    await page.keyboard.type(comment, { delay: 20 + Math.random() * 15 });
    await page.waitForTimeout(1500);
    
    const replyBtn = await page.waitForSelector('[data-testid="tweetButtonInline"]', { timeout: 5000 });
    await replyBtn.click();
    await page.waitForTimeout(4000);
    
    console.log("Reply posted!");
  } else {
    console.log("Post not found");
  }
  
  await browser.close();
})().catch(e => console.error("ERROR:", e.message));
