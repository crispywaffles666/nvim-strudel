{
  description = "nvim-strudel - Live code music in Neovim with Strudel";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs@{ flake-parts, nixpkgs, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];

      perSystem = { pkgs, ... }:
        let
          server = pkgs.buildNpmPackage {
            pname = "nvim-strudel-server";
            version = "0.1.0";
            src = ./server;
            npmDepsHash = "sha256-/2WY4YQWNnka6ibcIYLLG4IfNcZbFdKDE6I5cQxyJ+s=";
            nativeBuildInputs = with pkgs; [ makeWrapper pkg-config python3 ];
            buildInputs = nixpkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.alsa-lib ];
            npmBuildScript = "build";
            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib/nvim-strudel-server
              cp -r dist node_modules $out/lib/nvim-strudel-server/
              makeWrapper ${pkgs.nodejs}/bin/node $out/bin/strudel-server \
                --add-flags "$out/lib/nvim-strudel-server/dist/index.js"
              makeWrapper ${pkgs.nodejs}/bin/node $out/bin/strudel-lsp \
                --add-flags "$out/lib/nvim-strudel-server/dist/lsp.js --stdio"
              runHook postInstall
            '';
            meta = {
              description = "Backend server for nvim-strudel";
              homepage = "https://github.com/Goshujinsama/nvim-strudel";
              license = nixpkgs.lib.licenses.agpl3Only;
              mainProgram = "strudel-server";
            };
          };
        in
        {
          packages = {
            inherit server;
            default = server;
          };

          devShells.default = pkgs.mkShell {
            inputsFrom = [ server ];
            packages = with pkgs; [ nodejs prefetch-npm-deps ];
          };
        };
    };
}
