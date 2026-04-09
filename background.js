const OWNER = "imputnet";
const DEFAULT_REPO = "helium-windows";
const REPO_BY_OS = {
  win: "helium-windows",
  mac: "helium-macos",
  linux: "helium-linux"
};
const CHECK_INTERVAL_MINUTES = 1440;
const STORAGE_KEY = "heliumUpdateState";
const RELEASE_NOTIFICATION_ID = "helium-release-update";
const COMMIT_NOTIFICATION_ID = "helium-commit-update";
const NOTIFICATION_URL_KEY = "heliumNotificationTargetUrl";
const NOTIFICATION_ICON_URL = chrome.runtime.getURL("icons/icon128.png");
const AUTO_DOWNLOAD_ON_RELEASE_UPDATE = true;

function getOsFromUserAgent() {
  const ua = (navigator.userAgent || "").toLowerCase();
  if (ua.includes("mac os") || ua.includes("macintosh")) return "mac";
  if (ua.includes("linux")) return "linux";
  if (ua.includes("windows")) return "win";
  return "unknown";
}

function getRepoForOs(os) {
  return REPO_BY_OS[os] || DEFAULT_REPO;
}

function getPlatformInfo() {
  return new Promise((resolve, reject) => {
    chrome.runtime.getPlatformInfo((info) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(info);
    });
  });
}

async function getTargetRepo() {
  let os = "unknown";
  let arch = "unknown";

  try {
    const info = await getPlatformInfo();
    os = info?.os || os;
    arch = info?.arch || arch;
  } catch (_error) {
    os = getOsFromUserAgent();
  }

  const repo = getRepoForOs(os);
  return {
    owner: OWNER,
    repo,
    os,
    arch,
    repoUrl: `https://github.com/${OWNER}/${repo}`,
    releasesUrl: `https://github.com/${OWNER}/${repo}/releases`
  };
}

async function fetchLatestRelease(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json"
    }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Release fetch failed: ${response.status}`);
  }

  return response.json();
}

async function fetchDefaultBranch(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json"
    }
  });

  if (!response.ok) {
    throw new Error(`Repo fetch failed: ${response.status}`);
  }

  const repoInfo = await response.json();
  return repoInfo.default_branch;
}

async function fetchLatestCommit(owner, repo, defaultBranch) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(defaultBranch)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json"
    }
  });

  if (!response.ok) {
    throw new Error(`Commit fetch failed: ${response.status}`);
  }

  return response.json();
}

async function getCurrentSnapshot() {
  const target = await getTargetRepo();
  const release = await fetchLatestRelease(target.owner, target.repo);
  const defaultBranch = await fetchDefaultBranch(target.owner, target.repo);
  const commit = await fetchLatestCommit(target.owner, target.repo, defaultBranch);

  return {
    checkedAt: new Date().toISOString(),
    owner: target.owner,
    repoName: target.repo,
    repoUrl: target.repoUrl,
    platformOs: target.os,
    platformArch: target.arch,
    defaultBranch,
    releaseTag: release?.tag_name ?? null,
    releaseName: release?.name ?? null,
    releaseUrl: release?.html_url ?? null,
    releasePublishedAt: release?.published_at ?? null,
    releaseAssets: (release?.assets || []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size
    })),
    commitSha: commit?.sha ?? null,
    commitMessage: commit?.commit?.message?.split("\n")[0] ?? null,
    commitUrl: commit?.html_url ?? null,
    commitDate: commit?.commit?.author?.date ?? null
  };
}

function getArchTokens(arch) {
  if (arch === "arm64") return ["arm64", "aarch64"];
  if (arch === "x86_32") return ["x86", "x86_32", "i386", "32"];
  if (arch === "arm") return ["arm", "armv7", "armhf"];
  return ["x64", "x86_64", "amd64"];
}

function getOsTokens(os) {
  if (os === "mac") return ["mac", "macos", "darwin", ".dmg", ".pkg"];
  if (os === "linux") return ["linux", ".appimage", ".deb", ".rpm", ".tar.gz"];
  return ["windows", "win", ".exe", "installer"];
}

function isLikelyInstaller(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".sig") || lower.endsWith(".sha256") || lower.endsWith(".txt") || lower.endsWith(".json")) {
    return false;
  }
  return (
    lower.includes("installer") ||
    lower.endsWith(".exe") ||
    lower.endsWith(".msi") ||
    lower.endsWith(".dmg") ||
    lower.endsWith(".pkg") ||
    lower.endsWith(".appimage") ||
    lower.endsWith(".deb") ||
    lower.endsWith(".rpm")
  );
}

function scoreAssetForPlatform(assetName, os, arch) {
  const lower = assetName.toLowerCase();
  let score = 0;

  if (!isLikelyInstaller(lower)) return -1;

  for (const token of getOsTokens(os)) {
    if (lower.includes(token)) score += 5;
  }
  for (const token of getArchTokens(arch)) {
    if (lower.includes(token)) score += 3;
  }

  if (os === "win" && lower.endsWith(".exe")) score += 4;
  if (os === "mac" && (lower.endsWith(".dmg") || lower.endsWith(".pkg"))) score += 4;
  if (os === "linux" && (lower.endsWith(".appimage") || lower.endsWith(".deb") || lower.endsWith(".rpm"))) score += 4;

  return score;
}

function pickBestInstallerAsset(assets, os, arch) {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const scored = assets
    .map((asset) => ({
      ...asset,
      score: scoreAssetForPlatform(asset.name || "", os, arch)
    }))
    .filter((asset) => asset.score >= 0)
    .sort((a, b) => b.score - a.score);

  return scored[0] ?? null;
}

function downloadUrl(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false
      },
      (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

async function downloadLatestInstallerForState(state) {
  const asset = pickBestInstallerAsset(state.releaseAssets || [], state.platformOs, state.platformArch);
  if (!asset?.url || !asset?.name) {
    return { downloaded: false, reason: "No matching installer asset found for this platform." };
  }

  const safeRepo = (state.repoName || "helium").replace(/[^a-z0-9._-]/gi, "_");
  const filename = `helium-updates/${safeRepo}/${asset.name}`;
  const downloadId = await downloadUrl(asset.url, filename);
  return { downloaded: true, downloadId, assetName: asset.name, assetUrl: asset.url };
}

async function getStoredState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] ?? null;
}

async function setStoredState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function notifyUpdate(previous, current) {
  const releaseChanged = previous?.releaseTag !== current.releaseTag && Boolean(current.releaseTag);
  const commitChanged = previous?.commitSha !== current.commitSha;

  if (releaseChanged) {
    let downloadResult = null;
    if (AUTO_DOWNLOAD_ON_RELEASE_UPDATE) {
      try {
        downloadResult = await downloadLatestInstallerForState(current);
      } catch (error) {
        downloadResult = { downloaded: false, reason: String(error) };
      }
    }

    const targetUrl = current.releaseUrl || `${current.repoUrl}/releases`;
    await chrome.storage.local.set({ [NOTIFICATION_URL_KEY]: targetUrl });
    const message = downloadResult?.downloaded
      ? `Downloaded installer: ${downloadResult.assetName}. Click to open release page.`
      : "Click this notification to open the release page.";

    await chrome.notifications.create(RELEASE_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: NOTIFICATION_ICON_URL,
      title: `New ${current.repoName} Release: ${current.releaseTag}`,
      message,
      contextMessage: current.releaseName || `${current.owner}/${current.repoName}`,
      priority: 2,
      requireInteraction: true
    });
    return;
  }

  if (commitChanged) {
    const targetUrl = current.releaseUrl || current.commitUrl || current.repoUrl;
    await chrome.storage.local.set({ [NOTIFICATION_URL_KEY]: targetUrl });

    await chrome.notifications.create(COMMIT_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: NOTIFICATION_ICON_URL,
      title: `${current.repoName} Updated`,
      message: "Click this notification to open the latest update.",
      contextMessage: current.commitMessage || "New commit detected",
      priority: 2,
      requireInteraction: true
    });
  }
}

function didChange(previous, current) {
  if (!previous) return false;
  if (previous.repoName && current.repoName && previous.repoName !== current.repoName) {
    return false;
  }
  return previous.releaseTag !== current.releaseTag || previous.commitSha !== current.commitSha;
}

async function checkForUpdates({ notify = true, initialize = false } = {}) {
  try {
    const current = await getCurrentSnapshot();
    const previous = await getStoredState();

    if (!previous && initialize) {
      await setStoredState(current);
      return { updated: false, initialized: true, current };
    }

    const changed = didChange(previous, current);

    await setStoredState(current);
    if (changed && notify) {
      try {
        await notifyUpdate(previous, current);
      } catch (_error) {
        // Keep update detection healthy even if notification rendering fails.
      }
    }

    return { updated: changed, initialized: false, current };
  } catch (error) {
    const previous = await getStoredState();
    const failedState = {
      ...previous,
      lastError: String(error),
      checkedAt: new Date().toISOString()
    };
    await setStoredState(failedState);
    return { updated: false, initialized: false, error: String(error), current: failedState };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create("check-helium-updates", { periodInMinutes: CHECK_INTERVAL_MINUTES });
  await checkForUpdates({ notify: false, initialize: true });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("check-helium-updates", { periodInMinutes: CHECK_INTERVAL_MINUTES });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "check-helium-updates") return;
  await checkForUpdates({ notify: true });
});

async function openNotificationTargetUrl() {
  const data = await chrome.storage.local.get(NOTIFICATION_URL_KEY);
  const target = await getTargetRepo();
  const targetUrl = data[NOTIFICATION_URL_KEY] || target.releasesUrl;
  await chrome.tabs.create({ url: targetUrl });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId !== RELEASE_NOTIFICATION_ID && notificationId !== COMMIT_NOTIFICATION_ID) {
    return;
  }

  await openNotificationTargetUrl();
  await chrome.notifications.clear(notificationId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "check-now") {
    checkForUpdates({ notify: true })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "get-target-repo") {
    getTargetRepo()
      .then((target) => sendResponse({ ok: true, target }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "get-state") {
    getStoredState()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "download-latest-installer") {
    getStoredState()
      .then((state) => {
        if (!state) {
          throw new Error("No state found. Run a check first.");
        }
        return downloadLatestInstallerForState(state);
      })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});
