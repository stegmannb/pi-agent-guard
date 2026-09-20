{
  description = "pi-guard packaged as a Nix flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    llm-agents.url = "github:numtide/llm-agents.nix";
  };

  outputs =
    {
      llm-agents,
      nixpkgs,
      ...
    }:
    let
      lib = nixpkgs.lib;
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      runnerSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      forAllSystems = lib.genAttrs supportedSystems;

      extensionFor =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.callPackage ./nix/package.nix { };

      piFor =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          extension = extensionFor system;
          upstreamPi = llm-agents.packages.${system}.pi;
        in
        pkgs.writeShellApplication {
          name = "pi";
          text = ''
            exec ${lib.getExe upstreamPi} \
              --no-extensions \
              --extension "${extension}/guard/index.ts" \
              "$@"
          '';
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          extension = extensionFor system;
        in
        {
          default = extension;
          pi-guard = extension;
        }
        // lib.optionalAttrs (builtins.elem system runnerSystems) {
          pi = piFor system;
        }
      );

      apps = lib.genAttrs runnerSystems (
        system:
        let
          pi = piFor system;
          app = {
            type = "app";
            program = "${pi}/bin/pi";
            meta.description = "Run pi with pi-guard from this flake";
          };
        in
        {
          default = app;
          pi = app;
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
