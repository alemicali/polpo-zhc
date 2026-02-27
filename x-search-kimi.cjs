const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];
  
  // Search for Moonshot AI / Kimi founder
  await page.goto("https://x.com/search?q=moonshot%20AI%20kimi%20founder&f=user");
  await page.waitForTimeout(4000);
  
  const users = await page.evaluate(() => {
    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    const results = [];
    cells.forEach((cell, i) => {
      if (i >= 8) return;
      results.push(cell.innerText.replace(/\n/g, " | "));
    });
    return results;
  });
  
  console.log("=== Search: moonshot AI kimi founder (users) ===");
  users.forEach((u, i) => console.log((i+1) + ". " + u));
  
  // Also try direct search for the name
  await page.goto("https://x.com/search?q=%22Yang%20Zhilin%22%20OR%20%22Zhilin%20Yang%22%20OR%20%22moonshot%20ai%22&f=user");
  await page.waitForTimeout(4000);
  
  const users2 = await page.evaluate(() => {
    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    const results = [];
    cells.forEach((cell, i) => {
      if (i >= 8) return;
      results.push(cell.innerText.replace(/\n/g, " | "));
    });
    return results;
  });
  
  console.log("\n=== Search: Yang Zhilin / moonshot ai (users) ===");
  users2.forEach((u, i) => console.log((i+1) + ". " + u));
  
  await browser.close();
})().catch(e => console.error("ERROR:", e.message));
