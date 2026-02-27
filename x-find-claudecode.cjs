const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];

  await page.goto('https://x.com/search?q=%22claude%20code%22%20%22still%20haven%27t%20shipped%22&f=top');
  await page.waitForTimeout(4000);
  
  const tweets = await page.evaluate(() => {
    const articles = document.querySelectorAll("article");
    const results = [];
    articles.forEach((article, i) => {
      if (i >= 5) return;
      const nameEl = article.querySelector('[data-testid="User-Name"]');
      const textEl = article.querySelector('[data-testid="tweetText"]');
      const timeEl = article.querySelector("time");
      const groups = article.querySelectorAll('[role="group"] button');
      const metrics = [];
      groups.forEach(btn => {
        const aria = btn.getAttribute("aria-label");
        if (aria) metrics.push(aria);
      });
      let url = "";
      article.querySelectorAll('a[href*="/status/"]').forEach(l => {
        const href = l.getAttribute("href");
        if (href && href.match(/\/status\/\d+$/)) url = href;
      });
      results.push({
        name: nameEl ? nameEl.innerText.replace(/\n/g, " ").substring(0,80) : "",
        text: textEl ? textEl.innerText : "",
        time: timeEl ? timeEl.getAttribute("datetime") : "",
        url: url,
        metrics: metrics.join(" | "),
      });
    });
    return results;
  });
  
  console.log("=== Search results ===");
  tweets.forEach((t, i) => {
    console.log("---");
    console.log((i+1) + ". " + t.name);
    console.log("   " + t.text.substring(0, 400));
    console.log("   Time: " + t.time);
    console.log("   URL: https://x.com" + t.url);
    console.log("   " + t.metrics);
  });
  
  await browser.close();
})().catch(e => console.error("ERROR:", e.message));
