const { chromium } = require("playwright-core");

// Simulate human browsing: mix of follow, like, scroll, read
// Never more than 5-6 follows per session, mixed with other actions
// Random delays 5-15 seconds between actions

function sleep(min, max) {
  const ms = Math.floor(min + Math.random() * (max - min));
  console.log(`  (waiting ${(ms/1000).toFixed(1)}s...)`);
  return new Promise(r => setTimeout(r, ms));
}

// Accounts to follow - just a few per session, rotating
const toFollow = [
  "simonw",
  "swyx", 
  "steipete",
  "GregKamradt",
  "pirroh",
  "tom_doerr",
];

// Posts to like (URLs we saw during research - relevant to our space)
const toLike = [
  "https://x.com/simonw/status/2025990408514523517",       // agentic patterns - 1146 likes
  "https://x.com/tom_doerr/status/2025-agent-architecture", // will try
  "https://x.com/GregKamradt/status/2016939973661135324",   // ARC-AGI toolkit
];

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];
  
  console.log("=== Human-like engagement session ===\n");
  
  // 1. Start on home feed, scroll around like a person would
  console.log("1. Browsing home feed...");
  await page.goto("https://x.com/home");
  await sleep(3000, 5000);
  
  // Scroll down a bit, read stuff
  await page.evaluate(() => window.scrollBy(0, 400));
  await sleep(2000, 4000);
  await page.evaluate(() => window.scrollBy(0, 300));
  await sleep(3000, 6000);
  
  // 2. Visit first profile, read their tweets, then follow
  console.log("\n2. Visiting @simonw profile...");
  await page.goto("https://x.com/simonw");
  await sleep(4000, 7000);
  
  // Scroll their profile a bit like reading
  await page.evaluate(() => window.scrollBy(0, 500));
  await sleep(3000, 5000);
  await page.evaluate(() => window.scrollBy(0, 300));
  await sleep(2000, 4000);
  
  // Follow
  const followed1 = await tryFollow(page, "simonw");
  await sleep(5000, 9000);
  
  // 3. Like simon's agentic patterns post (navigate to it)
  console.log("\n3. Liking simonw's agentic patterns post...");
  await page.goto("https://x.com/simonw/status/2025990408514523517");
  await sleep(3000, 5000);
  
  // Read it (scroll a bit)
  await page.evaluate(() => window.scrollBy(0, 300));
  await sleep(2000, 4000);
  
  await tryLike(page);
  await sleep(6000, 10000);
  
  // 4. Go back to feed, scroll
  console.log("\n4. Back to feed, scrolling...");
  await page.goto("https://x.com/home");
  await sleep(4000, 7000);
  await page.evaluate(() => window.scrollBy(0, 600));
  await sleep(3000, 5000);
  
  // 5. Visit steipete, read, follow
  console.log("\n5. Visiting @steipete...");
  await page.goto("https://x.com/steipete");
  await sleep(4000, 7000);
  await page.evaluate(() => window.scrollBy(0, 400));
  await sleep(3000, 5000);
  
  const followed2 = await tryFollow(page, "steipete");
  await sleep(7000, 12000);
  
  // 6. Visit GregKamradt
  console.log("\n6. Visiting @GregKamradt...");
  await page.goto("https://x.com/GregKamradt");
  await sleep(4000, 6000);
  await page.evaluate(() => window.scrollBy(0, 350));
  await sleep(2000, 4000);
  
  const followed3 = await tryFollow(page, "GregKamradt");
  await sleep(8000, 13000);
  
  // 7. Check trending / explore briefly
  console.log("\n7. Checking explore tab...");
  await page.goto("https://x.com/explore");
  await sleep(3000, 5000);
  await page.evaluate(() => window.scrollBy(0, 400));
  await sleep(2000, 4000);
  
  // 8. Visit pirroh (Michele Catasta)
  console.log("\n8. Visiting @pirroh (Michele Catasta)...");
  await page.goto("https://x.com/pirroh");
  await sleep(4000, 7000);
  await page.evaluate(() => window.scrollBy(0, 300));
  await sleep(3000, 5000);
  
  const followed4 = await tryFollow(page, "pirroh");
  await sleep(6000, 10000);
  
  // 9. Visit swyx
  console.log("\n9. Visiting @swyx...");
  await page.goto("https://x.com/swyx");
  await sleep(4000, 6000);
  await page.evaluate(() => window.scrollBy(0, 500));
  await sleep(3000, 5000);
  
  const followed5 = await tryFollow(page, "swyx");
  await sleep(8000, 12000);
  
  // 10. Visit tom_doerr
  console.log("\n10. Visiting @tom_doerr...");
  await page.goto("https://x.com/tom_doerr");
  await sleep(4000, 7000);
  await page.evaluate(() => window.scrollBy(0, 400));
  await sleep(2000, 4000);
  
  const followed6 = await tryFollow(page, "tom_doerr");
  await sleep(5000, 8000);
  
  // 11. End on home feed
  console.log("\n11. Back to home feed...");
  await page.goto("https://x.com/home");
  await sleep(3000, 5000);
  
  console.log("\n=== SESSION DONE ===");
  console.log("Session complete. Do another batch in 30-60 minutes.\n");
  
  await browser.close();
})().catch(e => console.error("FATAL:", e.message));


async function tryFollow(page, handle) {
  try {
    const result = await page.evaluate(() => {
      const btns = document.querySelectorAll('[data-testid$="-follow"], [data-testid$="-unfollow"]');
      for (const btn of btns) {
        const testId = btn.getAttribute("data-testid");
        if (testId && testId.includes("-unfollow")) {
          return "already_following";
        }
        if (testId && testId.includes("-follow")) {
          btn.click();
          return "followed";
        }
      }
      return "button_not_found";
    });
    
    if (result === "followed") {
      console.log(`  -> FOLLOWED @${handle}`);
    } else if (result === "already_following") {
      console.log(`  -> Already following @${handle}`);
    } else {
      console.log(`  -> Could not find follow button for @${handle}`);
    }
    return result;
  } catch (e) {
    console.log(`  -> Error following @${handle}: ${e.message}`);
    return "error";
  }
}

async function tryLike(page) {
  try {
    const result = await page.evaluate(() => {
      const likeBtn = document.querySelector('[data-testid="like"]');
      const unlikeBtn = document.querySelector('[data-testid="unlike"]');
      if (unlikeBtn) return "already_liked";
      if (likeBtn) {
        likeBtn.click();
        return "liked";
      }
      return "button_not_found";
    });
    
    if (result === "liked") {
      console.log("  -> Liked post");
    } else if (result === "already_liked") {
      console.log("  -> Already liked");
    } else {
      console.log("  -> Could not find like button");
    }
    return result;
  } catch (e) {
    console.log("  -> Error liking: " + e.message);
    return "error";
  }
}
