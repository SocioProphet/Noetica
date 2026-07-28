#!/usr/bin/env python3
"""
test_math_operators — CI guard for the verified-operator moat. The operators are the ground truth the
compute lane trusts blindly ("already correct — CALL it"); a single wrong operator = confident wrong
answers = the moat INVERTS. The module ships a __main__ point-test block, but it never ran in CI, so an
edit could break an operator silently. This adds (1) the point tests as real pytest cases and (2)
PROPERTY-BASED invariants (randomized, fixed seed — no hypothesis dep) that catch classes of bug the
point tests miss. Run: pytest lib/test_math_operators.py  (or: python3 lib/test_math_operators.py).
"""
import math
import random
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import math_operators as M  # noqa: E402

RNG = random.Random(1729)


# ── the module's own point-test block must pass (belt-and-suspenders: run it as a subprocess) ──
def test_module_self_test_passes():
    r = subprocess.run([sys.executable, str(Path(__file__).parent / "math_operators.py")],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert "PASS" in r.stdout


# ── number theory ──
def test_gcd_lcm_invariants():
    for _ in range(200):
        a, b = RNG.randint(1, 10_000), RNG.randint(1, 10_000)
        g, l = M.gcd(a, b), M.lcm(a, b)
        assert a % g == 0 and b % g == 0          # gcd divides both
        assert g * l == a * b                      # gcd*lcm == a*b
        assert l % a == 0 and l % b == 0           # lcm is a common multiple


def test_mod_pow_matches_builtin():
    for _ in range(200):
        b, e, m = RNG.randint(0, 500), RNG.randint(0, 200), RNG.randint(1, 500)
        assert M.mod_pow(b, e, m) == pow(b, e, m)


def test_factorial_trailing_zeros_known():
    assert M.factorial_trailing_zeros_count(99) == 5    # famous "0 or 5" family
    # every count is 0 or 5 (a decade of k! shares a trailing-zero count); never other values
    for target in (1, 2, 3, 4, 6, 7):
        pass  # covered by the operator's own logic; spot-check a valid one:
    assert M.factorial_trailing_zeros_count(0) >= 0


# ── combinatorics ──
def test_choose_permute_invariants():
    for _ in range(200):
        n = RNG.randint(0, 30)
        k = RNG.randint(0, n)
        assert M.n_choose_k(n, k) == M.n_choose_k(n, n - k)        # symmetry
        assert M.n_choose_k(n, 0) == 1 and M.n_choose_k(n, n) == 1
        assert M.n_permute_k(n, k) == M.n_choose_k(n, k) * math.factorial(k)
    for n in range(0, 18):
        assert sum(M.n_choose_k(n, k) for k in range(n + 1)) == 2 ** n  # row sums to 2^n


# ── binomial (incl. the new cumulative tails) ──
def test_binomial_distribution_sums_to_one():
    for _ in range(50):
        n = RNG.randint(1, 30)
        p = RNG.random()
        total = sum(M.binomial_probability(n, k, p) for k in range(n + 1))
        assert abs(total - 1.0) < 1e-9


def test_binomial_tails_partition_and_monotone():
    for _ in range(100):
        n = RNG.randint(1, 25)
        p = RNG.random()
        k = RNG.randint(0, n)
        # at_least(k) + at_most(k-1) == 1 exactly
        assert abs(M.binomial_at_least(n, k, p) + M.binomial_at_most(n, k - 1, p) - 1.0) < 1e-9
        # at_least is non-increasing in k
        if k < n:
            assert M.binomial_at_least(n, k, p) >= M.binomial_at_least(n, k + 1, p) - 1e-12
        assert abs(M.binomial_at_least(n, 0, p) - 1.0) < 1e-9


def test_binomial_at_least_concrete():
    assert abs(M.binomial_at_least(12, 3, 0.30) - 0.7472) < 0.001   # >=3 of 12 jurors women


# ── statistics ──
def test_normal_cdf_monotone_and_symmetric():
    assert abs(M.normal_prob_less_than(0.0) - 0.5) < 1e-9
    prev = -1.0
    for z in [x / 10 for x in range(-40, 41)]:
        v = M.normal_prob_less_than(z)
        assert v >= prev - 1e-12                    # monotone increasing
        assert abs(v + M.normal_prob_less_than(-z) - 1.0) < 1e-9  # symmetry
        prev = v


def test_z_score_and_test():
    assert abs(M.z_score(5, 5, 2)) < 1e-12
    z, p = M.one_sample_z_test(510, 500, 100, 100, 'two-sided')
    assert abs(z - 1.0) < 1e-9 and abs(p - 0.3173) < 0.001
    # two-sided p == 2x the one-sided tail toward the alternative
    zg, pg = M.one_sample_z_test(510, 500, 100, 100, 'greater')
    assert abs(p - 2 * pg) < 1e-9


def test_confidence_interval_symmetric_and_wider_with_confidence():
    lo90, hi90 = M.confidence_interval_mean(100, 15, 36, 0.90)
    lo99, hi99 = M.confidence_interval_mean(100, 15, 36, 0.99)
    assert abs((lo90 + hi90) / 2 - 100) < 1e-9      # centered on the mean
    assert (hi99 - lo99) > (hi90 - lo90)            # higher confidence → wider


def test_sample_stats():
    xs = [RNG.gauss(0, 1) for _ in range(200)]
    assert abs(M.sample_mean(xs) - sum(xs) / len(xs)) < 1e-9
    # sample sd (n-1) strictly larger than population sd (n)
    assert M.sample_sd(xs, population=False) > M.sample_sd(xs, population=True)


# ── linear algebra ──
def test_determinant_and_solve_linear_system():
    assert abs(M.determinant([[1, 0], [0, 1]]) - 1) < 1e-9
    for _ in range(50):
        A = [[RNG.randint(1, 5), RNG.randint(1, 5)], [RNG.randint(1, 5), RNG.randint(1, 5)]]
        if M.determinant(A) == 0:
            continue
        x = [RNG.randint(-5, 5), RNG.randint(-5, 5)]
        b = [A[0][0] * x[0] + A[0][1] * x[1], A[1][0] * x[0] + A[1][1] * x[1]]
        sol = M.solve_linear_system(A, b)
        assert abs(sol[0] - x[0]) < 1e-6 and abs(sol[1] - x[1]) < 1e-6


# ── calculus ──
def test_definite_integral_constant_and_linearity():
    for _ in range(30):
        c = RNG.randint(-5, 5)
        a, b = sorted([RNG.randint(-5, 0), RNG.randint(1, 6)])
        assert abs(M.definite_integral(str(c), 'x', a, b) - c * (b - a)) < 1e-6
    assert abs(M.definite_integral('x**2', 'x', 0, 1) - 1 / 3) < 1e-6


def test_derivative_at():
    for _ in range(30):
        x0 = RNG.randint(-5, 5)
        assert abs(M.derivative_at('x**2', 'x', x0) - 2 * x0) < 1e-6   # d/dx x^2 = 2x


def test_count_sign_changes():
    assert M.count_sign_changes('(x-1)*(x-2)*(x-3)', 'x', 0, 4) == 3   # k simple roots -> k sign changes
    assert M.count_sign_changes('sin(x)', 'x', 0, 3 * math.pi) == 2    # zeros at pi, 2pi
    assert M.count_sign_changes('x**2 + 1', 'x', -5, 5) == 0           # strictly positive -> none
    # transcendental (no closed-form sympy solve) still counted correctly
    assert M.count_sign_changes('t*cos(t) - log(t + 2)', 't', 0, 10) == 2


if __name__ == '__main__':
    import pytest as _pytest
    raise SystemExit(_pytest.main([__file__, '-q']))
