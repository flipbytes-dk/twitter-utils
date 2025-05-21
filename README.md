# @twitter-utils

A JavaScript module for Twitter publishing service utilities, designed to be used as a git submodule and share dependencies with the host project.

## Structure

- `src/publishingService.js` - Main publishing service methods (ESM, modular)
- `src/mediaUpload.js` - Media upload utility
- `src/utils.js` - Token refresh and thread processing utilities
- `src/groups.js` - Group fetching utility
- `src/constants.js` - Constants (e.g., TweetStatus)
- `src/config.js` - Centralized config (host must provide db, Timestamp)
- `src/twitterApi.js` - Twitter API utilities (publish, refresh OAuth)

## Usage

Import the required methods from the submodule in your host project using ESM:

```js
import { publishTweet, verifyProjectAccess } from '@twitter-utils';
```

Ensure you provide the necessary config and dependencies.

## Development

- All methods are plain JavaScript (no TypeScript)
- Peer dependencies must be installed in the host project
- See TODOs in each file for implementation details
