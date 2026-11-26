# @otwdesign/plugin-google

## 1.1.0

### Minor Changes

- 23b451e: Google has one link in the admin menu. YouTube, Drive and Gmail are tabs across the Google
  screens, and the settings are under Settings › Google, as a WordPress plugin's are. The menu entry
  costs 601 bytes of a page rather than 1,882 (118 compressed rather than 445), and a tab opens the
  next screen without loading the page again. Needs OTW CMS 1.11 for its tabs and its icon's
  address.

  A service can have a tab: `screen`, its screen's address, in the `google.services` registry.
