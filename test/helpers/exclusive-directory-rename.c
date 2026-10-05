/* Synthetic scratch fixtures only. No production binding, fallback, retry or cleanup.
 * Publication uses one exclusive syscall. Pipe barriers belong to this test runner;
 * retained FDs do not prevent a same-user namespace rename after the final check.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <time.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <sys/acl.h>
#include <sys/stdio.h>
#elif defined(__linux__)
#include <linux/fs.h>
#include <sys/ioctl.h>
#else
#error "Exclusive publication unavailable on this platform"
#endif

static int stop(const char *phase) {
    printf("stopped:%s:%d\n", phase, errno);
    return 20;
}

static int identity(const struct stat *s, const char *expected) {
    char value[128];
    snprintf(value, sizeof(value), "%ju:%ju", (uintmax_t)s->st_dev, (uintmax_t)s->st_ino);
    return strcmp(value, expected) == 0 && s->st_uid == getuid();
}

static int same(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
           a->st_uid == b->st_uid && a->st_gid == b->st_gid;
}

static int leaf(const char *name) {
    return name[0] != '\0' && !strchr(name, '/') && strcmp(name, ".") && strcmp(name, "..");
}

/* Component-by-component O_NOFOLLOW: never canonicalize an unexpected alias. */
static int directory(int base, const char *relative) {
    if (!strcmp(relative, ".")) return dup(base);
    if (relative[0] == '/' || !relative[0] || strlen(relative) >= PATH_MAX) {
        errno = EINVAL;
        return -1;
    }
    char buffer[PATH_MAX];
    strcpy(buffer, relative);
    int fd = dup(base);
    char *part = buffer;
    while (fd >= 0) {
        char *slash = strchr(part, '/');
        if (slash) *slash = '\0';
        if (!leaf(part)) { close(fd); errno = EINVAL; return -1; }
        int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        close(fd);
        fd = next;
        if (!slash) break;
        part = slash + 1;
    }
    return fd;
}

static int binding(int root, const char *name, int retained) {
    int current = directory(root, name);
    struct stat a, b;
    int valid = current >= 0 && fstat(current, &a) == 0 && fstat(retained, &b) == 0 && same(&a, &b);
    if (current >= 0) close(current);
    return valid;
}

static int root_binding(const char *name, int retained) {
    int slash = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    int current = directory(slash, name + 1);
    close(slash);
    struct stat a, b;
    int valid = current >= 0 && fstat(current, &a) == 0 && fstat(retained, &b) == 0 && same(&a, &b);
    if (current >= 0) close(current);
    return valid;
}

static int barrier(const char *phase) {
    printf("%s\n", phase);
    fflush(stdout);
    struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN };
    char byte;
    if (poll(&input, 1, 5000) != 1 || read(STDIN_FILENO, &byte, 1) != 1 || byte != 'P') {
        errno = ECANCELED;
        return 0;
    }
    return 1;
}

/* Reject metadata we do not copy. No xattr/ACL values are read or printed. */
static int supported(const char *full, const struct stat *s, gid_t fixture_gid) {
    if ((!S_ISREG(s->st_mode) && !S_ISDIR(s->st_mode) && !S_ISLNK(s->st_mode)) ||
        s->st_uid != getuid() || s->st_gid != fixture_gid ||
        (S_ISREG(s->st_mode) && s->st_nlink != 1) ||
        (s->st_mode & (S_ISUID | S_ISGID | S_ISVTX))) { errno = ENOTSUP; return 0; }
#if defined(__APPLE__)
    if (s->st_flags != 0) { errno = ENOTSUP; return 0; }
    char names[4096];
    ssize_t attributes = listxattr(full, names, sizeof(names), XATTR_NOFOLLOW);
    if (attributes < 0) return 0;
    /* Darwin generates provenance even when xattr reports successful deletion.
     * This OS-maintained annotation is explicitly outside the synthetic copy
     * contract; every other attribute (including resource forks) blocks. */
    for (ssize_t i = 0; i < attributes; ) {
        size_t length = strnlen(names + i, (size_t)(attributes - i));
        if (length == (size_t)(attributes - i) || strcmp(names + i, "com.apple.provenance")) {
            errno = ENOTSUP; return 0;
        }
        i += (ssize_t)length + 1;
    }
    acl_t acl = acl_get_link_np(full, ACL_TYPE_EXTENDED);
    if (!acl) return errno == ENOENT; /* Darwin reports absent ACL as ENOENT. */
    acl_entry_t entry;
    errno = 0;
    int count = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
    int acl_errno = errno;
    acl_free(acl);
    /* Darwin returns 0 for an entry, -1/EINVAL for an empty ACL. */
    if (count == 0 || acl_errno != EINVAL) { errno = ENOTSUP; return 0; }
#else
    /* Linux ACLs are represented by xattrs too. Unsupported metadata blocks. */
    ssize_t attributes = llistxattr(full, NULL, 0);
    if (attributes < 0 || attributes > 0) { if (attributes > 0) errno = ENOTSUP; return 0; }
    if (!S_ISLNK(s->st_mode)) {
        int object = open(full, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        struct stat opened;
        unsigned long flags = 0;
        int valid = object >= 0 && fstat(object, &opened) == 0 && same(s, &opened) &&
                    ioctl(object, FS_IOC_GETFLAGS, &flags) == 0;
        if (object >= 0) close(object);
        /* Extents/index are storage implementation details, not mutable flags.
         * Unknown flag or unavailable inventory blocks this narrow fixture copier. */
        if (!valid || (flags & ~(unsigned long)(FS_EXTENT_FL | FS_INDEX_FL))) {
            errno = ENOTSUP; return 0;
        }
    }
#endif
    return 1;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (argc < 5) { errno = EINVAL; return stop("arguments"); }
    const char *root_name = argv[1];
    char scratch[PATH_MAX];
    if (!realpath("/tmp", scratch)) return stop("scratch-unavailable");
    size_t n = strlen(scratch);
    /* Only direct, private mkdtemp children of designated scratch. */
    if (strncmp(root_name, scratch, n) || root_name[n] != '/' ||
        strncmp(root_name + n + 1, "ink-cutover-fixture-", 20) || strchr(root_name + n + 1, '/')) {
        errno = EPERM; return stop("fixture-boundary");
    }
    int slash = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    int root = directory(slash, root_name + 1);
    close(slash);
    struct stat root_stat;
    if (root < 0 || fstat(root, &root_stat) || !identity(&root_stat, argv[2]) ||
        (root_stat.st_mode & 0777) != 0700) { errno = EPERM; return stop("fixture-root"); }
    int marker = openat(root, "fixture.marker", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat marker_stat;
    char marker_bytes[32] = {0};
    if (marker < 0 || fstat(marker, &marker_stat) || !S_ISREG(marker_stat.st_mode) ||
        marker_stat.st_uid != getuid() || marker_stat.st_nlink != 1 ||
        (marker_stat.st_mode & 0777) != 0600 || read(marker, marker_bytes, sizeof(marker_bytes)) != 26 ||
        memcmp(marker_bytes, "synthetic-cutover-fixture\n", 26)) {
        errno = EPERM; return stop("fixture-marker");
    }
    close(marker);
    if (!supported(root_name, &root_stat, root_stat.st_gid)) return stop("fixture-root-metadata");

    if (!strcmp(argv[3], "metadata") || !strcmp(argv[3], "times")) {
        char relative[PATH_MAX], full[PATH_MAX];
        if (strlen(argv[4]) >= sizeof(relative)) { errno = EINVAL; return stop("path"); }
        strcpy(relative, argv[4]);
        char *name = strrchr(relative, '/');
        int parent;
        if (name) { *name++ = '\0'; parent = directory(root, relative); }
        else { name = relative; parent = dup(root); }
        struct stat s;
        if (!leaf(name) || parent < 0 || fstatat(parent, name, &s, AT_SYMLINK_NOFOLLOW)) return stop("metadata-path");
        if (snprintf(full, sizeof(full), "%s/%s", root_name, argv[4]) >= (int)sizeof(full)) {
            errno = EINVAL; return stop("path");
        }
        if (!supported(full, &s, root_stat.st_gid)) return stop("unsupported-metadata");
        if (!strcmp(argv[3], "times")) {
            if (argc != 7) { errno = EINVAL; return stop("arguments"); }
            struct timespec times[2];
            for (int i = 0; i < 2; i++) {
                char *end;
                errno = 0;
                intmax_t ns = strtoimax(argv[5 + i], &end, 10);
                if (errno || *end || ns < 0) { errno = EINVAL; return stop("timestamp"); }
                times[i].tv_sec = (time_t)(ns / 1000000000);
                times[i].tv_nsec = (long)(ns % 1000000000);
            }
            if (utimensat(parent, name, times, AT_SYMLINK_NOFOLLOW)) return stop("timestamp-unavailable");
        }
        puts("ok");
        close(parent);
        close(root);
        return 0;
    }
    if (strcmp(argv[3], "publish") || argc != 11 || !leaf(argv[5]) || !leaf(argv[7])) {
        errno = EINVAL; return stop("arguments");
    }
    const char *sp = argv[4], *sn = argv[5], *dp = argv[6], *dn = argv[7];
    /* Lexical containment rejected before opening; aliases rejected by no-follow. */
    char src[PATH_MAX], dst[PATH_MAX];
    if (snprintf(src, sizeof(src), "%s%s%s", !strcmp(sp, ".") ? "" : sp,
                 !strcmp(sp, ".") ? "" : "/", sn) >= (int)sizeof(src) ||
        snprintf(dst, sizeof(dst), "%s%s%s", !strcmp(dp, ".") ? "" : dp,
                 !strcmp(dp, ".") ? "" : "/", dn) >= (int)sizeof(dst)) {
        errno = EINVAL; return stop("path");
    }
    size_t sl = strlen(src), dl = strlen(dst);
    if (!strcmp(src, dst) || (!strncmp(src, dst, sl) && dst[sl] == '/') ||
        (!strncmp(dst, src, dl) && src[dl] == '/')) { errno = EINVAL; return stop("containment"); }
    int source_parent = directory(root, sp), dest_parent = directory(root, dp);
    struct stat a, b, source, dest;
    if (source_parent < 0 || dest_parent < 0 || fstat(source_parent, &a) || fstat(dest_parent, &b) ||
        !identity(&a, argv[8]) || !identity(&b, argv[9]) ||
        a.st_gid != root_stat.st_gid || b.st_gid != root_stat.st_gid ||
        fstatat(source_parent, sn, &source, AT_SYMLINK_NOFOLLOW) || !S_ISDIR(source.st_mode) ||
        !identity(&source, argv[10]) || source.st_gid != root_stat.st_gid || source.st_dev != b.st_dev) {
        errno = EINVAL; return stop("precheck-identity");
    }
    if (fstatat(dest_parent, dn, &dest, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
        errno = EEXIST; return stop("precheck-conflict");
    }
    if (!barrier("precheck")) return stop("barrier");
    if (!root_binding(root_name, root) || !binding(root, sp, source_parent) ||
        !binding(root, dp, dest_parent) ||
        fstatat(source_parent, sn, &dest, AT_SYMLINK_NOFOLLOW) || !same(&source, &dest)) {
        errno = ESTALE; return stop("final-namespace");
    }
    if (!barrier("finalcheck")) return stop("barrier");
    int result;
#if defined(__APPLE__)
    result = renameatx_np(source_parent, sn, dest_parent, dn, RENAME_EXCL);
#else
    result = renameat2(source_parent, sn, dest_parent, dn, RENAME_NOREPLACE);
#endif
    int native_errno = result == 0 ? 0 : errno;
    printf("native:%d:%d\n", result, native_errno);
    if (!barrier("postcheck")) return stop("postcheck-unavailable");
    if (!root_binding(root_name, root) || !binding(root, sp, source_parent) || !binding(root, dp, dest_parent)) {
        errno = ESTALE; return stop("postcheck-namespace");
    }
    if (result != 0) { errno = native_errno; return stop("native-error"); }
    if (fstatat(dest_parent, dn, &dest, AT_SYMLINK_NOFOLLOW) || !same(&source, &dest) ||
        fstatat(source_parent, sn, &a, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
        errno = ESTALE; return stop("postcheck-identity");
    }
    puts("published");
    close(source_parent);
    close(dest_parent);
    close(root);
    return 0;
}
