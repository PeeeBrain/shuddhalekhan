import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';

const LATEST_RELEASE_URL = 'https://github.com/PeeeBrain/shuddhalekhan/releases/latest';
const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/PeeeBrain/shuddhalekhan/releases/latest';

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type LatestRelease = {
  assets?: ReleaseAsset[];
};

let latestInstallerUrl: Promise<string> | undefined;

function getLatestInstallerUrl() {
  latestInstallerUrl ??= fetch(LATEST_RELEASE_API_URL, {
    headers: { Accept: 'application/vnd.github+json' },
  })
    .then((response) => {
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      return response.json() as Promise<LatestRelease>;
    })
    .then((release) => {
      const installer = release.assets?.find((asset) => asset.name.toLowerCase().endsWith('.exe'));
      if (!installer) throw new Error('The latest release does not include a Windows installer');
      return installer.browser_download_url;
    })
    .catch(() => LATEST_RELEASE_URL);

  return latestInstallerUrl;
}

type LatestWindowsDownloadLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & {
  children: ReactNode;
};

export function LatestWindowsDownloadLink({ children, ...props }: LatestWindowsDownloadLinkProps) {
  const handleClick = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    window.location.assign(await getLatestInstallerUrl());
  };

  return (
    <a href={LATEST_RELEASE_URL} onClick={handleClick} {...props}>
      {children}
    </a>
  );
}
