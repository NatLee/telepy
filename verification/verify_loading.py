from playwright.sync_api import Page, expect, sync_playwright
import re

def verify_login_loading_state(page: Page):
    # 1. Arrange: Go to the login page.
    page.goto("http://localhost:8000/login")

    # 2. Act: Fill in the username and password.
    # We use more specific locators since get_by_label was ambiguous in the first-login page,
    # though now we are on the regular login page, it's safer to be specific.
    page.locator("#username").fill("admin")
    page.locator("#password").fill("admin")

    # Using route to delay
    # We delay the request to /api/auth/token to keep the button in loading state
    page.route("**/api/auth/token", lambda route: None) # Do nothing, request hangs

    # Find the submit button
    submit_btn = page.locator('button[type="submit"]')

    # Click it
    submit_btn.click()

    # 3. Assert: The button should have the 'btn-loading' class
    # We use a regex to match the class string containing 'btn-loading'
    expect(submit_btn).to_have_class(re.compile(r"btn-loading"))

    # And it should be disabled
    expect(submit_btn).to_be_disabled()

    # 4. Screenshot: Capture the loading state
    page.screenshot(path="/app/verification/login_loading_state.png")

if __name__ == "__main__":
  with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    try:
      verify_login_loading_state(page)
    finally:
      browser.close()
