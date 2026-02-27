const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];

  // Last attempt: Google search for his twitter handle
  await page.goto("https://www.google.com/search?q=Yang+Zhilin+Moonshot+AI+Kimi+twitter+%22%40%22");
  await page.waitForTimeout(4000);
  
  const googleResults = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll("div.g, div[data-sokoban-container]").forEach((el, i) => {
      if (i >= 6) return;
      results.push(el.innerText.substring(0, 300));
    });
    if (results.length === 0) {
      return [document.body.innerText.substring(0, 2000)];
    }
    return results;
  });
  
  console.log("=== Google search results ===");
  googleResults.forEach((r, i) => {
    console.log((i+1) + ". " + r.replace(/\n/g, " | "));
    console.log("");
  });

  await browser.close();
})().catch(e => console.error("ERROR:", e.message));
