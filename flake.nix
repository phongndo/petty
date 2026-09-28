{
  description = "Tau Terminal — A super-performant terminal emulator with Ghostty WASM";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };
        linuxElectronRuntimeLibs = pkgs.lib.optionals pkgs.stdenv.isLinux (with pkgs; [
          alsa-lib
          atk
          at-spi2-atk
          cairo
          cups
          dbus
          expat
          gdk-pixbuf
          glib
          gtk3
          libdrm
          libglvnd
          libgbm
          libxkbcommon
          mesa
          nspr
          nss
          pango
          udev
          libx11
          libxcomposite
          libxdamage
          libxext
          libxfixes
          libxrandr
          libxcb
        ]);
        linuxElectronLibraryPath = pkgs.lib.makeLibraryPath linuxElectronRuntimeLibs;
        linuxElectronMesa = pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.mesa}";
        # Use pnpm's native release binary at the packageManager version. nixpkgs' pnpm is a
        # Node launcher that adds ~200 ms to every command. Update hashes when bumping pnpm.
        pnpmVersion = pkgs.lib.removePrefix "pnpm@" (builtins.fromJSON (builtins.readFile ./package.json)).packageManager;
        pnpmTargets = {
          aarch64-darwin = { target = "darwin-arm64"; hash = "sha256-EDDzjhT6LmyH/mqwMTo787eUqWFQT0Q5utLKIRDTWD4="; };
          x86_64-darwin = { target = "darwin-x64"; hash = "sha256-uu4DOSn9dr3wGT6jWq1u+nrCkxuW8ngDKNJExwF0MGo="; };
          aarch64-linux = { target = "linux-arm64"; hash = "sha256-lzrys+uVCUFs+ImnM2cFBiyTZAfV/aBymIFOdTL13qE="; };
          x86_64-linux = { target = "linux-x64"; hash = "sha256-P0xm9mjQ6EIZZ5mC0JWzDaaDJeH6yShOf13BWEvT0T4="; };
        };
        pnpm = pkgs.stdenv.mkDerivation {
          pname = "pnpm";
          version = pnpmVersion;
          src = pkgs.fetchurl {
            url = "https://github.com/pnpm/pnpm/releases/download/v${pnpmVersion}/pnpm-${pnpmTargets.${system}.target}.tar.gz";
            inherit (pnpmTargets.${system}) hash;
          };
          sourceRoot = ".";
          dontStrip = true; # The executable embeds its JavaScript payload.
          nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.autoPatchelfHook ];
          buildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.stdenv.cc.cc.lib ];
          installPhase = ''
            mkdir -p $out/lib/pnpm $out/bin
            cp -r pnpm dist $out/lib/pnpm/
            ln -s $out/lib/pnpm/pnpm $out/bin/pnpm
          '';
        };
      in
      {
        # ── Dev shell (nix develop) ──
        devShells.default = pkgs.mkShell {
          name = "tau";

          # Build-time dependencies
          nativeBuildInputs = (with pkgs; [
            nodejs_24 # TypeScript scripts, tests and benchmarks (via tsx)
            nixd # Nix language server
            pnpm # Native pnpm pinned above (the let binding takes precedence over pkgs.pnpm)
            unzip # Electron's installer extracts its downloaded runtime with unzip
            zig_0_16 # taud daemon + pinned Ghostty native/WASM builds
            zls_0_16 # Zig language server matching Zig 0.16.x
            nixpkgs-fmt # nix fmt / CI format check
          ]) ++ pkgs.lib.optionals pkgs.stdenv.isLinux (with pkgs; [
            patchelf # Repair npm Electron's Linux interpreter in the dev shell
          ]);

          # Runtime dependencies for Electron
          # Linux-specific; macOS uses system frameworks.
          buildInputs = linuxElectronRuntimeLibs;

          shellHook = ''
            if [ "$(uname -s)" = "Linux" ]; then
              # VS Code and some tooling set this for extension hosts. It makes
              # Electron behave like Node, which breaks the app main process.
              unset ELECTRON_RUN_AS_NODE

              electron_append_path_without_nix_glibc() {
                local current_path="''${1:-}"
                local next_path=""
                local entry=""
                while [ -n "$current_path" ]; do
                  entry="''${current_path%%:*}"
                  if [ "$entry" = "$current_path" ]; then
                    current_path=""
                  else
                    current_path="''${current_path#*:}"
                  fi
                  case "$entry" in
                    *-glibc-*/lib|*-glibc-*/lib64) ;;
                    *) next_path="''${next_path:+$next_path:}$entry" ;;
                  esac
                done
                printf '%s' "$next_path"
              }

              electron_gl_lib_path=""
              for path in /run/opengl-driver/lib /run/opengl-driver-32/lib; do
                if [ -d "$path" ]; then
                  electron_gl_lib_path="''${electron_gl_lib_path:+$electron_gl_lib_path:}$path"
                fi
              done
              electron_inherited_ld_library_path="$(electron_append_path_without_nix_glibc "''${LD_LIBRARY_PATH:-}")"
              export LD_LIBRARY_PATH="${linuxElectronLibraryPath}''${electron_gl_lib_path:+:$electron_gl_lib_path}''${electron_inherited_ld_library_path:+:$electron_inherited_ld_library_path}"

              electron_egl_vendor_dirs=""
              for path in /run/opengl-driver/share/glvnd/egl_vendor.d /run/opengl-driver-32/share/glvnd/egl_vendor.d ${linuxElectronMesa}/share/glvnd/egl_vendor.d; do
                if [ -d "$path" ]; then
                  electron_egl_vendor_dirs="''${electron_egl_vendor_dirs:+$electron_egl_vendor_dirs:}$path"
                fi
              done
              export __EGL_VENDOR_LIBRARY_DIRS="$electron_egl_vendor_dirs''${__EGL_VENDOR_LIBRARY_DIRS:+:$__EGL_VENDOR_LIBRARY_DIRS}''${EGL_VENDOR_LIBRARY_DIRS:+:$EGL_VENDOR_LIBRARY_DIRS}"
              export LIBGL_DRIVERS_PATH="${linuxElectronMesa}/lib/dri''${LIBGL_DRIVERS_PATH:+:$LIBGL_DRIVERS_PATH}"
            fi

            echo "🖥  Tau Terminal dev shell"
            echo "   node:  $(node --version)"
            echo "   pnpm:  $(pnpm --version)"
            echo "   zig:   $(zig version)"
            echo "   zls:   $(zls --version)"
            echo ""
            echo "   pnpm install && pnpm dev"
            echo "   pnpm check           # TS + Zig lint/format/type/test checks"
            echo "   pnpm zig:lsp         # verify Zig language server availability"
            echo "   TypeScript LSP: ./node_modules/.bin/tsc --lsp --stdio (after pnpm install)"
            echo ""
          '';
        };

        checks.pnpm-runtime = pkgs.runCommand "tau-pnpm-runtime" { } ''
          export HOME="$TMPDIR"
          test "$(${pnpm}/bin/pnpm --version)" = '${pnpmVersion}'
          touch $out
        '';

        # ── Formatter (nix fmt) ──
        formatter = pkgs.nixpkgs-fmt;
      }
    );
}
