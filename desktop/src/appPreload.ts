import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("autorecipe", {
  open: (url: string) => ipcRenderer.invoke("autorecipe:open", url),
  startCapture: (payload: Record<string, string>) => ipcRenderer.invoke("autorecipe:capture-start", payload),
  stopCapture: () => ipcRenderer.invoke("autorecipe:capture-stop"),
  status: () => ipcRenderer.invoke("autorecipe:status"),
  inspector: () => ipcRenderer.invoke("autorecipe:inspector"),
  listRuns: () => ipcRenderer.invoke("autorecipe:runs:list"),
  getLearned: (payload?: { runId?: string }) => ipcRenderer.invoke("autorecipe:learned:get", payload || {}),
  openPath: (path: string) => ipcRenderer.invoke("autorecipe:open-path", path),
  setExplorationVisible: (visible: boolean) => ipcRenderer.invoke("ui:set-exploration-visible", visible),
  setWorkspaceExpanded: (expanded: boolean) => ipcRenderer.invoke("ui:set-workspace-expanded", expanded),
  getTheme: () => ipcRenderer.invoke("ui:theme:get"),
  setTheme: (choice: "system" | "light" | "dark") => ipcRenderer.invoke("ui:theme:set", choice),
  onThemeChange: (callback: (theme: "light" | "dark") => void) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: "light" | "dark") => callback(theme);
    ipcRenderer.on("autorecipe:set-theme", listener);
    return () => ipcRenderer.off("autorecipe:set-theme", listener);
  },
});
