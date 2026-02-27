const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];

  // Check the Kimi post where Zhilin Yang spoke on camera - might tag his personal account
  console.log("=== Checking Kimi's founder video post ===");
  await page.goto("https://x.com/Kimi_Moonshot");
  await page.waitForTimeout(3000);
  
  // Search for the specific post about founder
  await page.goto('https://x.com/search?q=from%3AKimi_Moonshot%20%22founder%22%20OR%20%22Zhilin%22&f=top');
  await page.waitForTimeout(3000);
  
  const posts = await page.evaluate(() => {
    const articles = document.querySelectorAll("article");
    const results = [];
    articles.forEach((article, i) => {
      if (i >= 5) return;
      const text = article.innerText.substring(0, 400);
      // Get all links/mentions
      const links = [];
      article.querySelectorAll('a[href^="/"]').forEach(a => {
        const h = a.getAttribute("href");
        if (h && h.match(/^\/[A-Za-z0-9_]+$/) && !h.includes("status")) links.push(h);
      });
      results.push({ text: text.replace(/\n/g, " | "), links: [...new Set(links)].join(", ") });
    });
    return results;
  });
  
  posts.forEach((p, i) => {
    console.log((i+1) + ". " + p.text.substring(0, 300));
    console.log("   Links: " + p.links);
  });

  // Try searching for Yang Zhilin directly as a user
  console.log("\n=== User search: Zhilin Yang ===");
  await page.goto('https://x.com/search?q=Zhilin%20Yang&f=user');
  await page.waitForTimeout(3000);
  
  const users = await page.evaluate(() => {
    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    const results = [];
    cells.forEach((cell, i) => {
      if (i >= 10) return;
      results.push(cell.innerText.replace(/\n/g, " | "));
    });
    return results;
  });
  
  users.forEach((u, i) => console.log((i+1) + ". " + u));

  // Try @YangZhilin or similar handles  
  const handles = ["YangZhilin", "zhilin_yang", "yangzhilin_", "zhiliny"];
  for (const h of handles) {
    await page.goto(`https://x.com/${h}`);
    await page.waitForTimeout(2000);
    const exists = await page.evaluate(() => {
      const err = document.querySelector('[data-testid="error-detail"]');
      if (err) return "NOT FOUND";
      const name = document.querySelector('[data-testid="UserName"]');
      const bio = document.querySelector('[data-testid="UserDescription"]');
      return (name ? name.innerText : "") + " | " + (bio ? bio.innerText : "");
    });
    console.log(`@${h}: ${exists}`);
  }

  await browser.close();
})().catch(e => console.error("ERROR:", e.message));
