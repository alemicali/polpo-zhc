const { chromium } = require("playwright-core");

// From our 100-TARGETS.md - key accounts to follow
// Mix of tiers to look natural, focused on our ICP
const targets = [
  // Tier S - the big ones we want algorithmic proximity to
  "karpathy",
  "garrytan",
  "levelsio",
  "steipete",
  "rauchg",
  "ThePrimeagen",
  "HarryStebbings",
  
  // Tier A - the ones we'll DM in weeks 3-6
  "simonw",
  "swyx",
  "omarsar0",
  "theo",
  "tom_doerr",
  "jessfraz",
  "dr_cintas",
  "alexalbert__",
  "skirano",
  "mitchellh",
  "antonosika",
  "hwchase17",
  "jerryjliu0",
  "emollick",
  "daltonc",
  
  // Tier B - more approachable, agent/orchestration space
  "GregKamradt",
  "jxnlco",
  "amanrsanger",
  "ErikBern",
  "RayFernando1337",
  "joaomdmoura",
  
  // Tier C - people we'll contact first
  "EyalToledano",
  "pirroh",
  "dkundel",
  "tobiaslins",
  "chronark_",
  "PaulCopplestone",
  
  // Key orgs/products in our space
  "temporalio",
  "trigdotdev",
  "inngest",
  "coolify_io",
];

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];
  
  let followed = 0;
  let alreadyFollowing = 0;
  let errors = 0;
  
  for (const handle of targets) {
    try {
      console.log(`--- Checking @${handle} ---`);
      await page.goto(`https://x.com/${handle}`);
      await page.waitForTimeout(2000 + Math.random() * 1500); // random delay to look human
      
      // Check if there's a Follow button (not Following)
      const followBtn = await page.evaluate(() => {
        // Look for the follow/following button
        const btns = document.querySelectorAll('[data-testid$="-follow"], [data-testid$="-unfollow"]');
        for (const btn of btns) {
          const testId = btn.getAttribute("data-testid");
          if (testId && testId.includes("-follow") && !testId.includes("-unfollow")) {
            return { status: "not_following", testId };
          }
          if (testId && testId.includes("-unfollow")) {
            return { status: "already_following", testId };
          }
        }
        return { status: "unknown" };
      });
      
      if (followBtn.status === "already_following") {
        console.log(`  Already following @${handle}`);
        alreadyFollowing++;
      } else if (followBtn.status === "not_following") {
        // Click follow
        const btn = await page.$(`[data-testid="${followBtn.testId}"]`);
        if (btn) {
          await btn.click();
          await page.waitForTimeout(1000);
          console.log(`  FOLLOWED @${handle}`);
          followed++;
        }
      } else {
        console.log(`  Could not find follow button for @${handle}`);
        errors++;
      }
      
      // Random delay between profiles (2-4 seconds)
      await page.waitForTimeout(2000 + Math.random() * 2000);
      
    } catch (e) {
      console.log(`  ERROR on @${handle}: ${e.message}`);
      errors++;
    }
  }
  
  console.log("\n=== SUMMARY ===");
  console.log(`Followed: ${followed}`);
  console.log(`Already following: ${alreadyFollowing}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total checked: ${targets.length}`);
  
  await browser.close();
})().catch(e => console.error("FATAL:", e.message));
