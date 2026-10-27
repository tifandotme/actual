terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }

  backend "gcs" {
    bucket = "actual-terraform-state"
    prefix = "actual"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# APIs

resource "google_project_service" "storage" {
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = true
}

resource "google_project_service" "secretmanager" {
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = true
}

# BUCKET

resource "google_storage_bucket" "actual_bucket" {
  name          = "actual-bucket-new"
  location      = var.region
  storage_class = "STANDARD"
  force_destroy = true

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  soft_delete_policy {
    retention_duration_seconds = 604800 # 7 days
  }

  depends_on = [google_project_service.storage]
}

# SERVICE ACCOUNT

resource "google_service_account" "actual_sa" {
  account_id   = "actual-server-sa"
  display_name = "Actual Server Service Account"
}

resource "google_project_iam_member" "actual_sa_storage" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.actual_sa.email}"
}

# CLOUD RUN

resource "google_cloud_run_v2_service" "actual_server" {
  name                = "actual-server"
  location            = var.region
  depends_on          = [google_project_service.run]
  deletion_protection = false

  template {
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
    containers {
      image = "actualbudget/actual-server:latest-alpine"
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      volume_mounts {
        name       = "gcs-data"
        mount_path = "/data"
      }
      startup_probe {
        tcp_socket {
          port = 8080
        }
        initial_delay_seconds = 0
        timeout_seconds       = 240
        period_seconds        = 240
        failure_threshold     = 1
      }
    }
    volumes {
      name = "gcs-data"
      gcs {
        bucket    = google_storage_bucket.actual_bucket.name
        read_only = false
      }
    }
    service_account = google_service_account.actual_sa.email
    timeout         = "300s"
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = google_cloud_run_v2_service.actual_server.project
  location = google_cloud_run_v2_service.actual_server.location
  name     = google_cloud_run_v2_service.actual_server.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# DOMAIN MAPPING

resource "google_cloud_run_domain_mapping" "actual_domain" {
  location = var.region
  name     = "actual.tifan.me"

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.actual_server.name
  }
}

# CI SERVICE ACCOUNT
resource "google_service_account" "ci_sa" {
  account_id   = "actual-ci-sa"
  display_name = "CI Service Account"
}

resource "google_project_iam_member" "ci_sa_secret_manager" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.ci_sa.email}"
}

resource "google_project_iam_member" "ci_sa_cloud_run" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.ci_sa.email}"
}

resource "google_service_account_iam_member" "ci_sa_act_as_actual_sa" {
  service_account_id = google_service_account.actual_sa.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.ci_sa.email}"
}

resource "google_service_account_key" "ci_sa_key" {
  service_account_id = google_service_account.ci_sa.name
  public_key_type    = "TYPE_X509_PEM_FILE"
}
