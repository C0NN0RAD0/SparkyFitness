#!/usr/bin/env bash
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

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/sparkyfitness ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  if check_for_gh_release "sparkyfitness" "C0NN0RAD0/SparkyFitness"; then
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
    $STD pnpm install
    msg_ok "Installed monorepo dependencies"

    msg_info "Building Sparky Fitness Backend"
    cd /opt/sparkyfitness/SparkyFitnessServer
    $STD pnpm run build
    msg_ok "Built Sparky Fitness Backend"

    msg_info "Building Sparky Fitness Frontend (Patience)"
    cd /opt/sparkyfitness/SparkyFitnessFrontend
    $STD pnpm run build
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
  fi
  exit
}

function install_sparkyfitness() {
  if [[ ! -d /opt/sparkyfitness ]]; then
    msg_error "SparkyFitness directory not found at /opt/sparkyfitness"
    return 1
  fi

  msg_info "Installing SparkyFitness (monorepo workspace)"
  
  # Install root-level workspace dependencies (required for monorepo to work)
  msg_info "Installing monorepo dependencies with pnpm (this may take several minutes)"
  cd /opt/sparkyfitness
  if pnpm install --frozen-lockfile; then
    msg_ok "Installed monorepo dependencies"
  else
    msg_error "Failed to install monorepo dependencies"
    return 1
  fi
  
  # Build frontend
  msg_info "Building SparkyFitness frontend (this may take a few minutes)"
  cd /opt/sparkyfitness
  if pnpm --filter sparkyfitnessfrontend run build; then
    msg_ok "Built frontend successfully"
    mkdir -p /var/www/sparkyfitness
    cp -a /opt/sparkyfitness/SparkyFitnessFrontend/dist/. /var/www/sparkyfitness/
    msg_ok "Deployed frontend"
  else
    msg_error "Frontend build failed"
    return 1
  fi
  
  msg_ok "SparkyFitness setup completed successfully"
}

start
build_container
install_sparkyfitness
description

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW} Access it using the following URL:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://${IP}${CL}"
