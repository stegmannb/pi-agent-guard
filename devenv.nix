{ pkgs, ... }:
{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    corepack.enable = true;
    pnpm.enable = true;
  };

  packages = with pkgs; [
    git
  ];

  enterShell = ''
    echo "pi-guard devenv ready"
    echo "Use: pnpm install && pnpm run verify"
  '';

  enterTest = ''
    pnpm install --frozen-lockfile
    pnpm run verify
  '';
}
