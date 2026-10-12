// Opens the browser host at run time. See stage_cef_host.h for why it is not linked.
#include "stage_cef_host.h"

#include <dlfcn.h>
#include <stdio.h>

const su_cef_api* su_cef_load(const char* path, char* error, size_t error_size) {
  void* handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!handle) {
    snprintf(error, error_size, "%s", dlerror());
    return NULL;
  }
  typedef const su_cef_api* (*get_api)(void);
  get_api get = (get_api)dlsym(handle, "su_cef_host_api");
  if (!get) {
    snprintf(error, error_size, "%s has no su_cef_host_api", path);
    return NULL;
  }
  const su_cef_api* api = get();
  if (!api || api->version != SU_CEF_API_VERSION) {
    snprintf(error, error_size, "%s is for host API version %u, this app needs %u", path,
             api ? api->version : 0u, (unsigned)SU_CEF_API_VERSION);
    return NULL;
  }
  return api;
}
