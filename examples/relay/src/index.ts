import { createRelay } from "@elmir-mamedov/feedback/relay";

// One entry per app. Its id is what the app passes as `app`; its repo is
// where its reports become issues. List `origins` for an app whose pages
// post straight from the browser, and leave them out for one that posts
// from its own server.
export default createRelay({
  apps: {
    "my-web-app": {
      repo: "you/my-web-app-feedback",
      name: "My Web App",
      origins: ["https://my-web-app.example.com", "http://localhost:5173"],
    },
    "my-local-app": {
      repo: "you/my-local-app-feedback",
      name: "My Local App",
    },
  },
});
