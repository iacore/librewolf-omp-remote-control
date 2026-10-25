// Hand URLs from other applications to background tabs: the new tab must not
// take selection and raise the window. This governs every external hand-off,
// not only the agent's.
user_pref("browser.tabs.loadDivertedInBackground", true);

// Enables chrome/userChrome.css, which hides the remote-control cue.
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
