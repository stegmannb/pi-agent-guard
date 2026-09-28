{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
}:
let
  version = "2.4.11";
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
  lockfile = builtins.readFile ../pnpm-lock.yaml;
  sources = {
    x86_64-linux = {
      platform = "linux-x64";
      hash = "sha512-TagWV0iomp5LnEnxWFg4nQO+e52Fow349vaX0Q/PIcX6Zhk4GGBgp3qqZ8PVkpC+cuehRctMf3+6+FgQ8jCEFQ==";
    };
    aarch64-linux = {
      platform = "linux-arm64";
      hash = "sha512-avdJaEElXrKceK0va9FkJ4P5ci3N01TGkc6ni3P8l3BElqbOz42Wg2IyX3gbh0ZLEd4HVKEIrmuVu/AMuSeFFA==";
    };
    x86_64-darwin = {
      platform = "darwin-x64";
      hash = "sha512-gZ6zR8XmZlExfi/Pz/PffmdpWOQ8Qhy7oBztgkR8/ylSRyLwfRPSadmiVCV8WQ8PoJ2MWUy2fgID9zmtgUUJmw==";
    };
    aarch64-darwin = {
      platform = "darwin-arm64";
      hash = "sha512-wOt+ed+L2dgZanWyL6i29qlXMc088N11optzpo10peayObBaAshbTcxKUchzEMp9QSY8rh5h6VfAFE3WTS1rqg==";
    };
  };
  source = sources.${stdenv.hostPlatform.system};
in
assert packageJson.devDependencies."@biomejs/biome" == version;
# hasInfix uses a whole-input regex that exhausts Linux Nix's stack on this lockfile.
assert
  builtins.replaceStrings
    [ "  '@biomejs/cli-${source.platform}@${version}':\n    resolution: {integrity: ${source.hash}}" ]
    [ "" ]
    lockfile != lockfile;
stdenv.mkDerivation {
  pname = "pi-guard-biome-ci";
  inherit version;

  src = fetchurl {
    url = "https://registry.npmjs.org/@biomejs/cli-${source.platform}/-/cli-${source.platform}-${version}.tgz";
    inherit (source) hash;
  };

  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];
  dontBuild = true;
  dontStrip = true;

  installPhase = ''
    runHook preInstall
    install -Dm755 biome "$out/bin/biome"
    runHook postInstall
  '';

  preInstallCheck = lib.optionalString stdenv.hostPlatform.isLinux ''
    test "$(patchelf --print-interpreter "$out/bin/biome")" = "${stdenv.cc.bintools.dynamicLinker}"
    runtimeLibraries=$("${stdenv.cc.bintools.dynamicLinker}" --list "$out/bin/biome")
    mkdir -p "$out/nix-support"
    {
      echo "ELF interpreter: $(patchelf --print-interpreter "$out/bin/biome")"
      echo "ELF RPATH: $(patchelf --print-rpath "$out/bin/biome")"
      echo "ELF needed libraries:"
      patchelf --print-needed "$out/bin/biome"
      echo "ELF resolved libraries:"
      # ASLR addresses are not part of the reproducible package output.
      printf '%s\n' "$runtimeLibraries" | sed -E 's/ \(0x[0-9a-f]+\)//g'
    } > "$out/nix-support/elf-runtime"
    cat "$out/nix-support/elf-runtime"
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    actualVersion=$("$out/bin/biome" --version)
    echo "$actualVersion"
    test "$actualVersion" = "Version: ${version}"
    # A real parser invocation must reject invalid JavaScript.
    if printf 'const = ;\n' | "$out/bin/biome" check --stdin-file-path=invalid.js > diagnostic 2>&1; then
      echo "Biome unexpectedly accepted invalid JavaScript" >&2
      exit 1
    fi
    cat diagnostic
    grep -q 'parsing errors' diagnostic
    runHook postInstallCheck
  '';

  meta = {
    description = "Locked npm Biome binary with Nix runtime paths for CI";
    license = lib.licenses.mit;
    platforms = builtins.attrNames sources;
    mainProgram = "biome";
  };
}
