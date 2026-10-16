import "./assets/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./theme/ThemeProvider";
import { playReplyNotification } from "./runtime/reply-notification";

const unsubscribeReplyNotifications = window.verbo.notifications.onReply(() => {
  void playReplyNotification();
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribeReplyNotifications);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
