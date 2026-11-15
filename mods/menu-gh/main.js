// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, agents, shared, setShared } from "herdr";

// The items for the menu this popup was opened for. A space's checkout ("main" for a repo's own,
// "linked" for a worktree, null for no repo) comes from the caller — spaces-tree already knows it
// — so opening a menu spawns no git process.
function items(p) {
  p = p ?? {};
  const git = p?.git ?? null;
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      const routing = term
        ? [toProgram
            ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
            : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }]]
        : [];
      // A terminal shown by a layout block (the wall) has no pane: split, zoom and close
      // would fail on it, so they are not offered.
      if (!panes().some((p) => p.pane === tg.pane)) {
        const one = agents().find((a) => a.address === tg.terminal);
        return [
          ...routing,
          ...(one ? [["Go to its space", "space.select", { id: one.space }]] : []),
        ];
      }
      return [
        ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
        ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
        ["Zoom", "pane.zoom", { pane: tg.pane }],
        ...routing,
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ["Close pane", "pane.close", { pane: tg.pane }],
      ];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        [git === "linked" ? "Remove branch" : "Remove space", "remove-space", { id: tg.id }],
      ];
    // A closed branch or space: its space is gone, so the only thing left to do with the row is
    // remove it. The record says which it was.
    case "kept": {
      const record = (shared("spaces-tree.spaces") ?? {})[tg.id];
      return [[record?.at?.id ? "Remove branch" : "Remove space", "remove-space", { id: tg.id }]];
    }
    default:
      return [
        ["New space", "space-new", {}],
        ["Settings", "settings", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command) {
  const name = command.endsWith(".close") || command === "remove-space" ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "settings" || command === "app.theme" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right. `pane.*` keys work on the
// pane with the keyboard, so they are only offered as a hint for that very pane.
function shortcut(name, args, focusedPane, bindings) {
  if (name.startsWith("pane.") && args?.pane && args.pane !== focusedPane) return "";
  return bound(name, args, bindings);
}

function bound(name, args, bindings) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = bindings.find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(i, cx) {
    const it = items(props())[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    if (it[1] === "worktree") openOverlay({ mod: "worktree-gh", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 460, height: 300 }), props: it[2] });
    // Asked before anything is made, as the spaces panel's + does.
    else if (it[1] === "space-new") openOverlay({ mod: "space-new", kind: "dialog", width: 430, height: 286 });
    // The row's own removal: the record, the space when it is open, and no row left behind.
    else if (it[1] === "remove-space") this.removeSpace(it[2].id, cx);
    // The settings Herdr's own window has no field for (the repos folder).
    else if (it[1] === "settings") run("mod.open", { name: "settings" });
    else run(it[1], it[2]);
  }

  // A removed row. A closed one loses its record at once — no space is behind it. A row whose
  // space is still open hands the ask to spaces-tree, which runs Herdr's own close for it: that
  // asks the person first, and the row goes when the space does, so a cancelled close leaves
  // everything as it was.
  removeSpace(id, cx) {
    if (spaces().some((s) => s.id === id)) {
      const asks = shared("spaces-tree.remove");
      setShared("spaces-tree.remove", { ...(asks && typeof asks === "object" ? asks : {}), [id]: Date.now() });
    } else {
      const all = shared("spaces-tree.spaces") ?? {};
      if (all[id]) {
        const next = { ...all };
        delete next[id];
        setShared("spaces-tree.spaces", next);
      }
    }
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const list = items(props());
    const focusedPane = panes().find((p) => p.focused)?.pane ?? null;
    // One read of the keybindings per menu, not one per row.
    const bindings = keys();
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && (it[1].endsWith(".close") || it[1] === "remove-space" || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it[1])).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().child(it[0]))
            .child(div().text_size(12).text_color(t.muted).child(shortcut(it[1], it[2], focusedPane, bindings)))),
        ),
      );
  }
}
