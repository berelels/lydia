"""Lydia's look. Everything is drawn with cairo from simple shapes, so there are
no image assets and the character is entirely original to this project."""

import math

import gi

gi.require_version("Pango", "1.0")
gi.require_version("PangoCairo", "1.0")
from gi.repository import Pango, PangoCairo  # noqa: E402

BODY = (0.62, 0.55, 0.95)        # calm lavender
BODY_ALERT = (0.98, 0.56, 0.42)  # warm coral when worried
INK = (0.15, 0.12, 0.27)
RADIUS = 46


def _mix(a, b, k):
    return tuple(x + (y - x) * k for x, y in zip(a, b))


def _ellipse(cr, cx, cy, rx, ry):
    cr.save()
    cr.translate(cx, cy)
    cr.scale(rx, max(ry, 0.01))
    cr.arc(0, 0, 1, 0, 2 * math.pi)
    cr.restore()


def draw_character(cr, cx, cy, t, alert, sleeping, look):
    """alert 0..1 (calm to worried), sleeping = alerts paused, look = (x, y) unit-ish."""
    import cairo

    bob = math.sin(t * 1.7) * (3.0 - 2.0 * alert)
    breath = math.sin(t * 1.7 + 0.6)
    shake = math.sin(t * 38) * 2.2 * alert
    cx += shake
    cy += bob
    body = _mix(BODY, BODY_ALERT, alert)
    if sleeping:
        body = _mix(body, (0.55, 0.55, 0.65), 0.55)

    # ground shadow
    cr.save()
    _ellipse(cr, cx, cy + RADIUS + 10 - bob, RADIUS * (0.8 - 0.05 * breath), 5)
    cr.set_source_rgba(0, 0, 0, 0.16)
    cr.fill()
    cr.restore()

    # little antenna
    sway = math.sin(t * 2.3) * 5 * (1 + alert)
    cr.save()
    cr.set_line_width(3)
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.move_to(cx, cy - RADIUS + 4)
    cr.curve_to(cx, cy - RADIUS - 8, cx + sway, cy - RADIUS - 12, cx + sway * 1.3, cy - RADIUS - 20)
    cr.set_source_rgb(*_mix(body, INK, 0.35))
    cr.stroke()
    cr.arc(cx + sway * 1.3, cy - RADIUS - 22, 5, 0, 2 * math.pi)
    cr.set_source_rgb(*_mix(body, (1, 1, 1), 0.25))
    cr.fill()
    cr.restore()

    # body
    cr.save()
    cr.translate(cx, cy)
    cr.scale(1 + 0.025 * breath, 1 - 0.025 * breath)
    cr.arc(0, 0, RADIUS, 0, 2 * math.pi)
    grad = cairo.RadialGradient(-14, -20, 4, 0, 0, RADIUS)
    grad.add_color_stop_rgb(0, *_mix(body, (1, 1, 1), 0.45))
    grad.add_color_stop_rgb(1, *body)
    cr.set_source(grad)
    cr.fill_preserve()
    cr.set_line_width(2)
    cr.set_source_rgba(*_mix(body, INK, 0.5), 0.45)
    cr.stroke()
    cr.restore()

    # cheeks
    for side in (-1, 1):
        _ellipse(cr, cx + side * 30, cy + 10, 7, 4.5)
        cr.set_source_rgba(1.0, 0.55, 0.65, 0.35 + 0.25 * alert)
        cr.fill()

    # eyes
    phase = t % 4.3
    blink = max(0.0, 1 - abs(phase - 4.15) / 0.12)
    openness = 1 - blink
    for side in (-1, 1):
        ex, ey = cx + side * 17, cy - 4
        if sleeping:
            cr.set_line_width(2.5)
            cr.set_source_rgb(*INK)
            cr.arc(ex, ey, 7, 0.15 * math.pi, 0.85 * math.pi)
            cr.stroke()
            continue
        grow = 1 + 0.25 * alert
        if alert > 0.05:  # white of the eye shows when worried
            _ellipse(cr, ex, ey, 9.5 * grow, 12 * grow * max(openness, 0.05))
            cr.set_source_rgba(1, 1, 1, alert)
            cr.fill()
        pupil = 1 - 0.35 * alert
        _ellipse(cr, ex + look[0] * 3.5, ey + look[1] * 3.5, 7.5 * pupil, 10 * pupil * max(openness, 0.05))
        cr.set_source_rgb(*INK)
        cr.fill()
        if openness > 0.5:
            cr.arc(ex + look[0] * 3.5 - 2.5, ey + look[1] * 3.5 - 3.5, 2.2, 0, 2 * math.pi)
            cr.set_source_rgba(1, 1, 1, 0.9)
            cr.fill()

    # mouth
    my = cy + 17
    cr.set_line_width(2.4)
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.set_source_rgb(*INK)
    if sleeping:
        cr.arc(cx, my, 3, 0, 2 * math.pi)
        cr.stroke()
    elif alert > 0.3:
        cr.move_to(cx - 9, my)
        steps = 12
        for i in range(1, steps + 1):
            x = cx - 9 + 18 * i / steps
            cr.line_to(x, my + math.sin(i * 1.3 + t * 14) * 2.2)
        cr.stroke()
    else:
        cr.arc(cx, my - 4, 7, 0.2 * math.pi, 0.8 * math.pi)
        cr.stroke()

    # sweat drop when worried
    if alert > 0.2 and not sleeping:
        dy = (t * 28) % 26
        dx = cx + 36
        dyy = cy - 30 + dy
        cr.save()
        cr.move_to(dx, dyy - 9)
        cr.curve_to(dx + 7, dyy, dx + 6, dyy + 7, dx, dyy + 7)
        cr.curve_to(dx - 6, dyy + 7, dx - 7, dyy, dx, dyy - 9)
        cr.set_source_rgba(0.55, 0.8, 1.0, min(1, alert) * (1 - dy / 30))
        cr.fill()
        cr.restore()

    # snoring z's
    if sleeping:
        for i in range(2):
            k = ((t * 0.5 + i * 0.5) % 1.0)
            cr.save()
            cr.set_source_rgba(*INK, 1 - k)
            cr.select_font_face("Sans", 0, 1)
            cr.set_font_size(12 + 6 * i)
            cr.move_to(cx + 34 + k * 14, cy - 28 - k * 26)
            cr.show_text("z")
            cr.restore()


def draw_bubble(cr, width, top, text):
    """Speech bubble centered under the character. Returns its (x, y, w, h)."""
    layout = PangoCairo.create_layout(cr)
    layout.set_font_description(Pango.FontDescription("Sans 10"))
    layout.set_width(int((width - 60) * Pango.SCALE))
    layout.set_wrap(Pango.WrapMode.WORD_CHAR)
    layout.set_text(text, -1)
    tw, th = layout.get_pixel_size()
    pad = 11
    bw, bh = tw + pad * 2, th + pad * 2
    bx = (width - bw) / 2
    r = 12

    cr.new_path()
    cr.move_to(bx + r, top)
    cr.line_to(width / 2 - 8, top)
    cr.line_to(width / 2, top - 8)
    cr.line_to(width / 2 + 8, top)
    cr.line_to(bx + bw - r, top)
    cr.arc(bx + bw - r, top + r, r, -math.pi / 2, 0)
    cr.line_to(bx + bw, top + bh - r)
    cr.arc(bx + bw - r, top + bh - r, r, 0, math.pi / 2)
    cr.line_to(bx + r, top + bh)
    cr.arc(bx + r, top + bh - r, r, math.pi / 2, math.pi)
    cr.line_to(bx, top + r)
    cr.arc(bx + r, top + r, r, math.pi, 1.5 * math.pi)
    cr.close_path()
    cr.set_source_rgba(0.12, 0.11, 0.2, 0.93)
    cr.fill_preserve()
    cr.set_source_rgba(1, 1, 1, 0.18)
    cr.set_line_width(1)
    cr.stroke()

    cr.move_to(bx + pad, top + pad)
    cr.set_source_rgb(0.96, 0.95, 1.0)
    PangoCairo.show_layout(cr, layout)
    return int(bx), int(top - 8), int(bw), int(bh + 8)
