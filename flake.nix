{
  description = "Amazombie development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      dependencies = pkgs: pkgs.buildNpmPackage {
        pname = "amazombie-dependencies";
        version = "1.0.0";
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [ ./package.json ./package-lock.json ];
        };
        npmDepsHash = "sha256-Znfs1YGJUGfjnfnEXga048IsQ0YjWrKwGER7mPiVctg=";
        nodejs = pkgs.nodejs_24;
        npmInstallFlags = [ "--include=dev" ];
        dontNpmBuild = true;
        installPhase = ''
          mkdir -p "$out"
          cp -R node_modules "$out/node_modules"
        '';
      };
    in {
      packages = forEachSystem (pkgs: { node-deps = dependencies pkgs; });
      devShells = forEachSystem (pkgs:
        let nodeDeps = dependencies pkgs; in {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_24 pkgs.supabase-cli pkgs.docker-client pkgs.cargo pkgs.rustc ];
            shellHook = ''
              if [ -L node_modules ] && [[ "$(readlink node_modules)" == /nix/store/*/node_modules ]]; then
                ln -sfn "${nodeDeps}/node_modules" node_modules
              elif [ -e node_modules ] || [ -L node_modules ]; then
                echo "Move the existing node_modules aside and re-enter the Nix shell." >&2
                exit 1
              else
                ln -s "${nodeDeps}/node_modules" node_modules
              fi
            '';
          };
        });
    };
}
