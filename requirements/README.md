# Requirements Drop Zone

Every morning before you leave for work, drop a file called `today.md` in this folder.

The agent army reads it when it starts and uses it as the day's mission brief.

## How to Use

1. Copy `template.md` → rename to `today.md`
2. Fill in what you want built today
3. Start the army: `cd agents && npm start`
4. Go to work
5. Come home → review the PR on GitHub

## What Happens Without a File

If `today.md` is missing, the army defaults to:
- Code review and cleanup
- Improving test coverage
- Search algorithm optimization
- Security scan

## Tips

- Be specific about what you want. "Make the product cards look better" is ok,
  but "Make the product cards show the retailer name below the price, with a
  small logo if we have one" is much better.

- You can reference specific files: "In App.jsx, the wishlist panel feels clunky on mobile..."

- Set priorities. The PM will sequence work but knowing what matters most helps.

- You don't need to be technical. Describe the user experience you want.

## Archive

After each day, rename `today.md` to `YYYY-MM-DD.md` to keep a history of what was built.
