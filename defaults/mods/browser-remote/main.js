import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, exec, theme, window } from "herdr";

export default class BrowserRemote extends View {
  open(file, cx) {
    const path = appHome() + "/mods/browser-remote/chrome" + (file ? "/viewer.html" : "");
    const platform = window()?.platform;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = platform === "windows"
          ? await exec("powershell.exe", ["-NoProfile", "-Command", "Invoke-Item -LiteralPath '" + path.replace(/'/g, "''") + "'"])
          : await exec(platform === "macos" ? "open" : "xdg-open", [path]);
        if (result.code !== 0) throw new Error(result.stderr.trim() || "The system opener failed.");
      } catch (error) {
        this.error = String(error.message ?? error);
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    const button = (id, label, viewer) => div().id(id).px(10).py(6).rounded(6)
      .bg(t.raised).hover(style => style.bg(t.selected))
      .on_click((_event, cx) => this.open(viewer, cx)).child(label);
    return v_flex().size_full().p(16).gap(10).bg(t.popover).text_color(t.foreground)
      .child(div().text_size(17).child("Browser Remote"))
      .child(div().text_color(t.dim).child("Open the viewer on this device. On the computer you want to control, load the Herdr extension in Chrome and use it to share a browser window."))
      .child(h_flex().gap(8).child(button("remote-viewer", "Open viewer", true))
        .child(button("remote-extension", "Show extension folder", false)))
      .when(Boolean(this.error), el => el.child(div().child(this.error)));
  }
}
