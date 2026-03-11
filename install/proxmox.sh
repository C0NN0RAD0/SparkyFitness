#!/usr/bin/env bash
echo "███████████████████████████████████████████████████████████"
echo "🎯 SparkyFitness v2.0 Installation Script (Monorepo Support)"
echo "✨ Updated: 2026-03-11 - Proper pnpm workspace handling"
echo "███████████████████████████████████████████████████████████"

source <(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func)
# Copyright (c) 2021-2026 community-scripts ORG
# Author: Tom Frenzel (tomfrenzel)
# License: MIT | https://github.com/community-scripts/ProxmoxVE/raw/main/LICENSE
# Source: https://github.com/C0NN0RAD0/SparkyFitness

APP="SparkyFitness"
var_tags="${var_tags:-health;fitness}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-2048}"
var_disk="${var_disk:-4}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_unprivileged="${var_unprivileged:-1}"

header_info "$APP"
variables
color
catch_errors

function install() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🎯 SparkyFitness Installation (v2.0 with Monorepo Support)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  # CRITICAL: Install root monorepo dependencies FIRST before any builds
  echo "📦 Installing worksp dependencies (shared/, SparkyFitnessServer/, etc)..."
  cd /opt/sparkyfitness
  pnpm install --frozen-lockfile || { echo "❌ Failed to install monorepo dependencies"; exit 1; }
  echo "✅ Monorepo dependencies ready"
  echo ""
}

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/sparkyfitness ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  if check_for_gh_release "sparkyfitness" "C0NN0RAD0/SparkyFitness"; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🎯 SparkyFitness Update (v2.0 with Monorepo Support)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    msg_info "Stopping Services"
    systemctl stop sparkyfitness-server nginx
    msg_ok "Stopped Services"

    msg_info "Backing up data"
    mkdir -p /opt/sparkyfitness_backup
    if [[ -d /opt/sparkyfitness/SparkyFitnessServer/uploads ]]; then
      cp -r /opt/sparkyfitness/SparkyFitnessServer/uploads /opt/sparkyfitness_backup/
    fi
    if [[ -d /opt/sparkyfitness/SparkyFitnessServer/backup ]]; then
      cp -r /opt/sparkyfitness/SparkyFitnessServer/backup /opt/sparkyfitness_backup/
    fi
    msg_ok "Backed up data"

    CLEAN_INSTALL=1 fetch_and_deploy_gh_release "sparkyfitness" "C0NN0RAD0/SparkyFitness" "tarball"

    PNPM_VERSION="$(jq -r '.packageManager | split("@")[1]' /opt/sparkyfitness/package.json)"
    NODE_VERSION="25" NODE_MODULE="pnpm@${PNPM_VERSION}" setup_nodejs

    msg_info "Installing Sparky Fitness (monorepo root) - this may take several minutes"
    cd /opt/sparkyfitness
    $STD pnpm install --frozen-lockfile
    msg_ok "Installed monorepo dependencies"

    msg_info "Building Sparky Fitness Frontend (Patience)"
    cd /opt/sparkyfitness
    $STD pnpm --filter sparkyfitnessfrontend run build
    cp -a /opt/sparkyfitness/SparkyFitnessFrontend/dist/. /var/www/sparkyfitness/
    msg_ok "Built Sparky Fitness Frontend"

    msg_info "Restoring data"
    cp -r /opt/sparkyfitness_backup/. /opt/sparkyfitness/SparkyFitnessServer/
    rm -rf /opt/sparkyfitness_backup
    msg_ok "Restored data"

    msg_info "Starting Services"
    $STD systemctl start sparkyfitness-server nginx
    msg_ok "Started Services"
    msg_ok "Updated successfully!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "✨ SparkyFitness v2.0 update complete!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  fi
  exit
}

start

build_container
description

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW} Access it using the following URL:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://${IP}${CL}"
