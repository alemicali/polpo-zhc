const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];
  
  // Try searching for the actual founder with different queries
  const searches = [
    "moonshot AI CEO",
    "杨植麟",
    "kimi CEO moonshot",
    "Yang Zhilin CMU moonshot",
  ];
  
  for (const q of searches) {
    console.log(`\n=== Search: "${q}" ===`);
    await page.goto(`https://x.com/search?q=${encodeURIComponent(q)}&f=top`);
    await page.waitForTimeout(3000);
    
    const tweets = await page.evaluate(() => {
      const articles = document.querySelectorAll("article");
      const results = [];
      articles.forEach((article, i) => {
        if (i >= 4) return;
        const nameEl = article.querySelector('[data-testid="User-Name"]');
        const textEl = article.querySelector('[data-testid="tweetText"]');
        results.push({
          name: nameEl ? nameEl.innerText.replace(/\n/g, " ").substring(0,60) : "",
          text: textEl ? textEl.innerText.substring(0, 200) : "",
        });
      });
      return results;
    });
    
    tweets.forEach((t, i) => {
      console.log((i+1) + ". " + t.name);
      console.log("   " + t.text);
    });
  }
  
  // Also try web search approach - search for his handle
  console.log("\n=== Search: 'Yang Zhilin' moonshot twitter ===");
  await page.goto("https://x.com/search?q=%22Yang+Zhilin%22+moonshot&f=top");
  await page.waitForTimeout(3000);
  
  const results = await page.evaluate(() => {
    const articles = document.querySelectorAll("article");
    const out = [];
    articles.forEach((article, i) => {
      if (i >= 5) return;
      const textEl = article.querySelector('[data-testid="tweetText"]');
      const nameEl = article.querySelector('[data-testid="User-Name"]');
      // Also look for any @mentions
      const mentions = [];
      article.querySelectorAll('a[href^="/"]').forEach(a => {
        const href = a.getAttribute("href");
        if (href && href.match(/^\/[A-Za-z0-9_]+$/) && !href.includes("/status")) {
          mentions.push(href);
        }
      });
      out.push({
        name: nameEl ? nameEl.innerText.replace(/\n/g, " ").substring(0,60) : "",
        text: textEl ? textEl.innerText.substring(0, 250) : "",
        mentions: [...new Set(mentions)].join(", "),
      });
    });
    return out;
  });
  
  results.forEach((r, i) => {
    console.log((i+1) + ". " + r.name);
    console.log("   " + r.text);
    if (r.mentions) console.log("   Mentions: " + r.mentions);
  });
  
  await browser.close();
})().catch(e => console.error("ERROR:", e.message));
