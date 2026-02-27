const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];
  
  // Check the profiles that could be the real Zhilin Yang
  const candidates = ["zhilinYang17", "zhilinyang10", "zhilin48727"];
  
  for (const handle of candidates) {
    console.log(`\n=== Checking @${handle} ===`);
    await page.goto(`https://x.com/${handle}`);
    await page.waitForTimeout(3000);
    
    const profile = await page.evaluate(() => {
      const nameEl = document.querySelector('[data-testid="UserName"]');
      const bioEl = document.querySelector('[data-testid="UserDescription"]');
      const followersEl = document.querySelectorAll('a[href*="/followers"], a[href*="/verified_followers"]');
      const headerEl = document.querySelector('[data-testid="UserProfileHeader_Items"]');
      
      let followers = "";
      followersEl.forEach(el => {
        if (el.href && el.href.includes("followers")) {
          followers += el.innerText + " ";
        }
      });
      
      return {
        name: nameEl ? nameEl.innerText : "",
        bio: bioEl ? bioEl.innerText : "",
        followers: followers.trim(),
        header: headerEl ? headerEl.innerText : "",
      };
    });
    
    console.log("Name: " + profile.name);
    console.log("Bio: " + profile.bio);
    console.log("Followers: " + profile.followers);
    console.log("Info: " + profile.header);
  }
  
  // Also check @Kimi_Moonshot to find who they follow/interact with
  console.log("\n=== Checking @Kimi_Moonshot ===");
  await page.goto("https://x.com/Kimi_Moonshot");
  await page.waitForTimeout(3000);
  
  const kimiProfile = await page.evaluate(() => {
    const nameEl = document.querySelector('[data-testid="UserName"]');
    const bioEl = document.querySelector('[data-testid="UserDescription"]');
    const headerEl = document.querySelector('[data-testid="UserProfileHeader_Items"]');
    let followInfo = "";
    document.querySelectorAll('a[href*="/follow"]').forEach(el => {
      followInfo += el.innerText + " | ";
    });
    return {
      name: nameEl ? nameEl.innerText : "",
      bio: bioEl ? bioEl.innerText : "",
      header: headerEl ? headerEl.innerText : "",
      follows: followInfo,
    };
  });
  
  console.log("Name: " + kimiProfile.name);
  console.log("Bio: " + kimiProfile.bio);
  console.log("Info: " + kimiProfile.header);
  console.log("Follow info: " + kimiProfile.follows);
  
  await browser.close();
})().catch(e => console.error("ERROR:", e.message));
