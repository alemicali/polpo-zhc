#!/usr/bin/env python3
"""Take a full-page screenshot of insurtechsolutions.it using Selenium."""

import time
import sys
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

def take_full_page_screenshot(url, output_path):
    options = Options()
    options.add_argument('--headless=new')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--disable-gpu')
    options.add_argument('--window-size=1920,1080')
    options.add_argument('--force-device-scale-factor=1')
    # Allow all content to load
    options.add_argument('--disable-web-security')
    options.add_argument('--allow-running-insecure-content')
    
    print(f"Starting Chrome...")
    driver = webdriver.Chrome(options=options)
    
    try:
        print(f"Navigating to {url}...")
        driver.set_page_load_timeout(30)
        driver.get(url)
        
        print("Waiting 5 seconds for dynamic content to load...")
        time.sleep(5)
        
        # Scroll slowly to bottom to trigger lazy loading
        print("Scrolling to bottom...")
        total_height = driver.execute_script("return document.body.scrollHeight")
        viewport_height = driver.execute_script("return window.innerHeight")
        current = 0
        step = 300
        while current < total_height:
            current += step
            driver.execute_script(f"window.scrollTo(0, {current});")
            time.sleep(0.3)
            # Recalculate in case page grew
            total_height = driver.execute_script("return document.body.scrollHeight")
        
        print("Waiting 3 seconds after scroll for lazy-loaded content...")
        time.sleep(3)
        
        # Scroll back to top
        print("Scrolling back to top...")
        driver.execute_script("window.scrollTo(0, 0);")
        time.sleep(2)
        
        # Get the full page dimensions
        total_width = driver.execute_script("return document.body.scrollWidth")
        total_height = driver.execute_script("return document.body.scrollHeight")
        print(f"Page dimensions: {total_width}x{total_height}")
        
        # Resize window to full page size for complete screenshot
        # Chrome DevTools Protocol for full-page screenshot
        driver.set_window_size(1920, total_height)
        time.sleep(2)
        
        # Take screenshot
        print(f"Taking screenshot and saving to {output_path}...")
        driver.save_screenshot(output_path)
        
        print(f"Screenshot saved successfully! Size: {total_width}x{total_height}")
        return True
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return False
    finally:
        driver.quit()

if __name__ == '__main__':
    url = "https://insurtechsolutions.it"
    output = "insurtech_homepage_full.png"
    
    success = take_full_page_screenshot(url, output)
    if not success:
        print("Trying www variant...")
        success = take_full_page_screenshot("https://www.insurtechsolutions.it", output)
    
    sys.exit(0 if success else 1)
