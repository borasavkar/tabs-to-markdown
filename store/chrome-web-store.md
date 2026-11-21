# Chrome Web Store — "Privacy practices" answers

The developer dashboard asks for these when submitting. Paste as written.

## Single purpose

Save the content of the web pages the user chooses (open tabs, a tab group or pasted links) as Markdown files on the user's computer, so they can be uploaded to AI assistants.

## Permission justifications

- **tabs:** List the user's open tabs with their titles and addresses so the user can choose which ones to save; open pasted links in background tabs and close them after reading.
- **tabGroups:** Show tab groups and their names in the tab picker, suggest a folder name from the group name, and put tabs the user chose to keep open into a group.
- **downloads:** Save the generated Markdown files into the user's Downloads folder.
- **storage:** Remember the user's settings, recently used folder names and which pages were saved to which folder, locally in extension storage.
- **scripting:** Inject the page reader into the tabs the user chose to save, so their content can be converted to Markdown.
- **Host permission `<all_urls>` (optional, requested at first use):** The user can save pages from any website, so the extension needs to read the content of whichever site the user selects. Pages are read only when the user starts a job.

## Remote code

No. All code is included in the package (Mozilla Readability and Turndown are bundled, unmodified).

## Data usage

Check **none** of the data types: the extension does not collect or transmit user data. Website content is processed locally and saved only as files on the user's computer.

Certify:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL

Needed: the text is in `store/privacy-policy.md`; it has to be published at a public address first.
