const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];

  // Check the handles that returned something (not "NOT FOUND")
  const handles = ["YangZhilin", "zhilin_yang", "yangzhilin_", "zhiliny", "lostsm"];
  
  for (const h of handles) {
    console.log(`\n=== @${h} ===`);
    await page.goto(`https://x.com/${h}`);
    await page.waitForTimeout(2500);
    
    const info = await page.evaluate(() => {
      const err = document.querySelector('[data-testid="error-detail"]');
      if (err) return { exists: false };
      const name = document.querySelector('[data-testid="UserName"]');
      const bio = document.querySelector('[data-testid="UserDescription"]');
      const header = document.querySelector('[data-testid="UserProfileHeader_Items"]');
      let followInfo = "";
      document.querySelectorAll('a[href*="/follow"]').forEach(el => {
        followInfo += el.innerText + " | ";
      });
      return {
        exists: true,
        name: name ? name.innerText : "",
        bio: bio ? bio.innerText : "",
        header: header ? header.innerText : "",
        follows: followInfo,
      };
    });
    
    if (!info.exists) {
      console.log("  Account does not exist");
    } else {
      console.log("  Name: " + info.name);
      console.log("  Bio: " + info.bio);
      console.log("  Info: " + info.header);
      console.log("  Follows: " + info.follows);
    }
  }
  
  // Also check @NielsRogge's tweet which mentioned Kimi_Moonshot CEO being first author of XLNet
  // Try to search for Niels' tweet and see if anyone tagged the real account
  console.log("\n=== Checking Niels Rogge tweet about Kimi CEO ===");
  await page.goto("https://x.com/search?q=from%3ANielsRogge%20Kimi_Moonshot%20CEO&f=top");
  await page.waitForTimeout(3000);
  
  const niels = await page.evaluate(() => {
    const article = document.querySelector("article");
    if (!article) return "no results";
    return article.innerText.substring(0, 500).replace(/\n/g, " | ");
  });
  console.log(niels);

  await browser.close();
})().catch(e => console.error("ERROR:", e.message));
