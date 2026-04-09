const STORAGE_KEY = "heliumUpdateState";

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function shortSha(sha) {
  return sha ? sha.slice(0, 7) : "-";
}

function setText(id, text, className = "") {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = className;
}

function setTrackingRepo(owner, repoName) {
  const tracking = document.getElementById("trackingRepo");
  tracking.textContent = `${owner}/${repoName}`;
}

function setOpenRepoUrl(url) {
  const link = document.getElementById("openRepo");
  link.href = url;
}

function prettyOs(value) {
  const map = {
    win: "Windows",
    mac: "macOS",
    linux: "Linux",
    cros: "ChromeOS",
    android: "Android",
    openbsd: "OpenBSD",
    fuchsia: "Fuchsia"
  };
  return map[value] || value || "Unknown OS";
}

function prettyArch(value) {
  const map = {
    x86_64: "x64",
    arm64: "ARM64",
    x86_32: "x86",
    arm: "ARM"
  };
  return map[value] || value || "Unknown Arch";
}

function renderPlatform(state) {
  const os = prettyOs(state?.platformOs);
  const arch = prettyArch(state?.platformArch);
  setText("platform", `Detected platform: ${os} (${arch})`, "muted");
}

function renderState(state) {
  if (state?.owner && state?.repoName) {
    setTrackingRepo(state.owner, state.repoName);
  }
  if (state?.repoUrl) {
    setOpenRepoUrl(state.repoUrl);
  }
  renderPlatform(state);

  if (!state) {
    setText("status", "No checks have run yet.", "status-warn");
    setText("release", "Latest release: -");
    setText("commit", "Latest commit: -");
    setText("checked", "Last checked: -", "muted");
    return;
  }

  if (state.lastError) {
    setText("status", `Last check failed: ${state.lastError}`, "status-warn");
  } else {
    setText("status", "Monitoring is active.", "status-ok");
  }

  setText("release", `Latest release: ${state.releaseTag ?? "none"}`);
  setText("commit", `Latest commit: ${shortSha(state.commitSha)} ${state.commitMessage ? `- ${state.commitMessage}` : ""}`);
  setText("checked", `Last checked: ${formatDate(state.checkedAt)}`, "muted");
}

async function getState() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "get-state" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error ?? "Could not load state."));
        return;
      }
      resolve(response.state);
    });
  });
}

async function getTargetRepo() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "get-target-repo" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error ?? "Could not load target repo."));
        return;
      }
      resolve(response.target);
    });
  });
}

async function checkNow() {
  setText("status", "Checking now...", "status-ok");
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "check-now" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error ?? "Check failed."));
        return;
      }
      resolve(response.result.current);
    });
  });
}

async function downloadLatestInstaller() {
  setText("status", "Preparing installer download...", "status-ok");
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "download-latest-installer" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error ?? "Download failed."));
        return;
      }
      resolve(response.result);
    });
  });
}

async function resetStateForTest() {
  const testState = {
    checkedAt: new Date(0).toISOString(),
    owner: null,
    repoName: null,
    repoUrl: null,
    platformOs: null,
    platformArch: null,
    defaultBranch: null,
    releaseTag: null,
    releaseName: null,
    releaseUrl: null,
    releasePublishedAt: null,
    commitSha: null,
    commitMessage: null,
    commitUrl: null,
    commitDate: null
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: testState });
  return testState;
}

async function init() {
  const checkButton = document.getElementById("checkNow");
  const resetButton = document.getElementById("resetTest");
  const downloadButton = document.getElementById("downloadInstaller");

  checkButton.addEventListener("click", async () => {
    checkButton.disabled = true;
    try {
      const state = await checkNow();
      renderState(state);
    } catch (error) {
      setText("status", `Check failed: ${String(error)}`, "status-warn");
    } finally {
      checkButton.disabled = false;
    }
  });

  resetButton.addEventListener("click", async () => {
    checkButton.disabled = true;
    resetButton.disabled = true;
    try {
      const state = await resetStateForTest();
      renderState(state);
      setText("status", "Baseline reset. Click 'Check now' to test notification.", "status-ok");
    } catch (error) {
      setText("status", `Reset failed: ${String(error)}`, "status-warn");
    } finally {
      checkButton.disabled = false;
      resetButton.disabled = false;
    }
  });

  downloadButton.addEventListener("click", async () => {
    checkButton.disabled = true;
    resetButton.disabled = true;
    downloadButton.disabled = true;
    try {
      const result = await downloadLatestInstaller();
      if (result.downloaded) {
        setText("status", `Downloading: ${result.assetName}`, "status-ok");
      } else {
        setText("status", result.reason || "No matching installer asset found.", "status-warn");
      }
    } catch (error) {
      setText("status", `Download failed: ${String(error)}`, "status-warn");
    } finally {
      checkButton.disabled = false;
      resetButton.disabled = false;
      downloadButton.disabled = false;
    }
  });

  try {
    const [state, target] = await Promise.all([getState(), getTargetRepo()]);
    if (target) {
      if (target.owner && target.repo) {
        setTrackingRepo(target.owner, target.repo);
      }
      if (target.repoUrl) {
        setOpenRepoUrl(target.repoUrl);
      }
      renderPlatform({ platformOs: target.os, platformArch: target.arch });
    }
    renderState(state);
  } catch (error) {
    setText("status", `Failed to load state: ${String(error)}`, "status-warn");
  }
}

init();
