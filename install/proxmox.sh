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

  # When SPARKYFITNESS_BRANCH is set, deploy directly from that branch instead of
  # the latest GitHub release. This is intended for testing a PR or branch before
  # it is merged and released.
  local use_branch="${SPARKYFITNESS_BRANCH:-}"

  # Validate branch name: only allow alphanumerics, hyphens, underscores, dots, and forward slashes
  if [[ -n "$use_branch" && ! "$use_branch" =~ ^[a-zA-Z0-9/_.-]+$ ]]; then
    msg_error "Invalid branch name: '${use_branch}'. Only alphanumerics, hyphens, underscores, dots, and slashes are allowed."
    exit 1
  fi

  if [[ -n "$use_branch" ]] || check_for_gh_release "sparkyfitness" "C0NN0RAD0/SparkyFitness"; then
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

    if [[ -n "$use_branch" ]]; then
      msg_info "Downloading source from branch: ${use_branch}"
      local branch_url="https://github.com/C0NN0RAD0/SparkyFitness/archive/refs/heads/${use_branch}.tar.gz"
      if ! wget -q -O /tmp/sparkyfitness-branch.tar.gz "$branch_url"; then
        msg_error "Failed to download branch '${use_branch}' from GitHub. Check the branch name and your network connection."
        rm -f /tmp/sparkyfitness-branch.tar.gz
        exit 1
      fi
      rm -rf /opt/sparkyfitness
      mkdir -p /opt/sparkyfitness
      tar -xzf /tmp/sparkyfitness-branch.tar.gz -C /opt/sparkyfitness --strip-components=1
      rm -f /tmp/sparkyfitness-branch.tar.gz
      msg_ok "Downloaded source from branch: ${use_branch}"
    else
      CLEAN_INSTALL=1 fetch_and_deploy_gh_release "sparkyfitness" "C0NN0RAD0/SparkyFitness" "tarball"
    fi

    PNPM_VERSION="$(jq -r '.packageManager | split("@")[1]' /opt/sparkyfitness/package.json)"
    NODE_VERSION="25" NODE_MODULE="pnpm@${PNPM_VERSION}" setup_nodejs

    msg_info "Updating Sparky Fitness Backend"
    cd /opt/sparkyfitness/SparkyFitnessServer
    $STD npm install
    msg_ok "Updated Sparky Fitness Backend"

    msg_info "Updating Sparky Fitness Frontend (Patience)"
    cd /opt/sparkyfitness
    $STD pnpm install
    $STD pnpm --filter sparkyfitnessfrontend run build
    cp -a /opt/sparkyfitness/SparkyFitnessFrontend/dist/. /var/www/sparkyfitness/
    msg_ok "Updated Sparky Fitness Frontend"

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

start
build_container
description

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW} Access it using the following URL:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://${IP}${CL}"
