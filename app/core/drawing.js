(function (app) {
  "use strict";

  function cloneValue(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(cloneValue);
    var output = {};
    Object.keys(value).forEach(function (key) { if (key.charAt(0) !== "_") output[key] = cloneValue(value[key]); });
    return output;
  }
  function cloneObject(object) {
    if (!object || typeof object !== "object") return object;
    var output = {};
    Object.keys(object).forEach(function (key) {
      if (key.charAt(0) === "_") return;
      var value = object[key];
      if (key === "points" && Array.isArray(value)) {
        var points = new Array(value.length);
        for (var index = 0; index < value.length; index += 1) points[index] = { x: value[index].x, y: value[index].y };
        output.points = points;
      } else output[key] = value && typeof value === "object" ? cloneValue(value) : value;
    });
    return output;
  }
  function cloneObjects(objects) { return (objects || []).map(cloneObject); }
  function storageObject(object) {
    var copy = cloneObject(object); delete copy.src;
    if (copy.url && /^(data:|blob:)/.test(copy.url)) delete copy.url;
    return copy;
  }
  //: Rotation is stored in radians and read through one accessor, so a record written
  //: before rotation existed (no field at all) and one written with a NaN both come out
  //: as "not turned" instead of poisoning every downstream calculation.
  function rotationOf(object) {
    var value = Number(object && object.rotation);
    return Number.isFinite(value) ? value : 0;
  }
  //: The centre an object's angle is applied about. An object turned on its own keeps the
  //: record it always had - an angle and nothing else - and that angle is read as being about
  //: the object's own centre. Turning a whole selection needs more than that: members carried
  //: round one shared centre would drift apart if each of them spun about its own, so the
  //: centre travels with the angle once a selection has been turned, and the two are folded
  //: together into one angle about one centre so that no turn has to be replayed or accumulated.
  function rotationPivotOf(object) {
    var pivot = object && object.rotationPivot;
    return pivot && Number.isFinite(Number(pivot.x)) && Number.isFinite(Number(pivot.y)) ? { x: Number(pivot.x), y: Number(pivot.y) } : null;
  }
  function normalizeAngle(angle) {
    var value = Number(angle) || 0;
    while (value <= -Math.PI) value += Math.PI * 2;
    while (value > Math.PI) value -= Math.PI * 2;
    return value;
  }
  //: The turn a container gave this object, and the centre it was given about. A group is a
  //: container: it carries an angle of its own - upright when the group is formed - which sits
  //: over whatever angle each member already had, so two members at different angles turn
  //: together without either adopting the other's, and neither loses its own on ungroup.
  function groupRotationOf(object) {
    var value = Number(object && object.groupRotation);
    return Number.isFinite(value) ? value : 0;
  }
  function groupPivotOf(object) {
    var pivot = object && object.groupPivot;
    return pivot && Number.isFinite(Number(pivot.x)) && Number.isFinite(Number(pivot.y)) ? { x: Number(pivot.x), y: Number(pivot.y) } : null;
  }
  function boxCentre(box) { return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }
  //: A placement, as the six numbers a two-dimensional transform is made of: `x = a x + c y + e`,
  //: `y = b x + d y + f` - which is also the order the canvas takes them, so a placement can be
  //: handed to `ctx.transform` as it stands. The record carries a placement at two levels, its own
  //: and its container's, and everything drawn is the container's applied to the member's.
  //:
  //: It is written as a matrix rather than as an angle about a centre because a container is not
  //: only turned: it may also be scaled by different amounts along its two axes, and a turn
  //: composed with such a scale is not a turn about any centre. A container that only ever turns
  //: still writes itself as a turn - `fromRotation` - so nothing about the ordinary case changes.
  var identity = [1, 0, 0, 1, 0, 0];
  //: `compose(m, n)` is the placement that does `n` first and `m` afterwards.
  function compose(m, n) {
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }
  function invert(m) {
    var determinant = m[0] * m[3] - m[1] * m[2];
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
    return [m[3] / determinant, -m[1] / determinant, -m[2] / determinant, m[0] / determinant,
      (m[2] * m[5] - m[3] * m[4]) / determinant, (m[1] * m[4] - m[0] * m[5]) / determinant];
  }
  function applyTo(m, x, y) { return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }; }
  function cornersOf(m, box) {
    return [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
      .map(function (corner) { return applyTo(m, corner[0], corner[1]); });
  }
  //: The upright box that holds what a box looks like once placed - the same thing `turnedBox` is
  //: for a turn, written for any placement. It is what every axis-aligned consumer has to be told
  //: if it is not to believe the upright rectangle the record spells.
  function boxOfMap(m, box) {
    var points = cornersOf(m, box);
    var left = Math.min(points[0].x, points[1].x, points[2].x, points[3].x), right = Math.max(points[0].x, points[1].x, points[2].x, points[3].x);
    var top = Math.min(points[0].y, points[1].y, points[2].y, points[3].y), bottom = Math.max(points[0].y, points[1].y, points[2].y, points[3].y);
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }
  function fromRotation(angle, pivot) {
    var cos = Math.cos(angle), sin = Math.sin(angle);
    return [cos, sin, -sin, cos, pivot.x - (cos * pivot.x - sin * pivot.y), pivot.y - (sin * pivot.x + cos * pivot.y)];
  }
  //: A turn composed with a scale along the axes that turn created - which is what a container's
  //: "angle and size" always means, and what every container operation can only ever produce.
  function fromRotationScale(angle, scaleX, scaleY, centre) {
    var cos = Math.cos(angle), sin = Math.sin(angle);
    var a = cos * scaleX, b = sin * scaleX, c = -sin * scaleY, d = cos * scaleY;
    return [a, b, c, d, centre.x - (a * centre.x + c * centre.y), centre.y - (b * centre.x + d * centre.y)];
  }
  function fromScale(scaleX, scaleY, pivot) { return [scaleX, 0, 0, scaleY, pivot.x - scaleX * pivot.x, pivot.y - scaleY * pivot.y]; }
  //: The placement that scales what a container draws, along the container's own two axes, about a
  //: point of the drawing. The scale goes on the *inside* - between the container's rectangle and the
  //: container's placement - because those two are one pair: the rectangle is the box the members
  //: fill, and the placement is what carries it. A scale composed on the outside leaves the rectangle
  //: behind, and an even scale that way throws the angle away with it - a turn composed with an even
  //: scale is that turn again, while an even scale about the world axes is set at no angle at all, so
  //: the box would stand itself upright the first time a group was pulled by the same amount on both
  //: axes. Written on the inside, the anchor is a point of the rectangle, so the corner the hand is
  //: holding stays under the hand.
  function scaleInAxes(m, scaleX, scaleY, anchor) {
    var back = invert(m);
    if (!back) return m;
    return compose(m, fromScale(scaleX, scaleY, applyTo(back, anchor.x, anchor.y)));
  }
  function angleOf(m) { return Math.atan2(m[1], m[0]); }
  function axesOf(m) { return [Math.sqrt(m[0] * m[0] + m[1] * m[1]), Math.sqrt(m[2] * m[2] + m[3] * m[3])]; }
  function isIdentity(m) { return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0; }
  //: A placement whose two axes are square to each other is a turn and a size, which is a rectangle
  //: again and can be boxed by one. Anything else - and the only way to arrive there is to hand a
  //: member a container's uneven scale - is a shear, which no rectangle can hold.
  function isSquare(m) { return Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-9; }
  function holdsStill(m) {
    var a = 1 - m[0], b = -m[2], c = -m[1], d = 1 - m[3];
    var determinant = a * d - b * c;
    if (Math.abs(determinant) < 1e-12) return null;
    return { x: (d * m[4] - b * m[5]) / determinant, y: (a * m[5] - c * m[4]) / determinant };
  }
  var placement = { identity: identity, compose: compose, invert: invert, apply: applyTo, corners: cornersOf, boxOf: boxOfMap,
    fromRotation: fromRotation, fromRotationScale: fromRotationScale, fromScale: fromScale, scaleInAxes: scaleInAxes,
    angleOf: angleOf, axesOf: axesOf, isIdentity: isIdentity, isSquare: isSquare, holdsStill: holdsStill };
  //: A box carried round a pivot. Four corners, turned about that pivot rather than about the
  //: box's own centre - the difference is the whole point of a group turn, where the centre is
  //: not the box's own - then the box that holds them, which is what a turned rectangle looks
  //: like from outside and what every axis-aligned consumer has to be told if it is not to
  //: believe the upright rectangle the record spells.
  function turnedBox(box, angle, pivot) {
    if (!angle) return box;
    var halfWidth = box.width / 2, halfHeight = box.height / 2;
    var offsetX = box.x + halfWidth - pivot.x, offsetY = box.y + halfHeight - pivot.y;
    var cos = Math.cos(angle), sin = Math.sin(angle);
    var left = 0, right = 0, top = 0, bottom = 0;
    for (var index = 0; index < 4; index += 1) {
      var cornerX = offsetX + (index === 0 || index === 3 ? -halfWidth : halfWidth);
      var cornerY = offsetY + (index < 2 ? -halfHeight : halfHeight);
      var x = pivot.x + cornerX * cos - cornerY * sin;
      var y = pivot.y + cornerX * sin + cornerY * cos;
      if (!index) { left = x; right = x; top = y; bottom = y; continue; }
      if (x < left) left = x; if (x > right) right = x;
      if (y < top) top = y; if (y > bottom) bottom = y;
    }
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }
  //: The box the record spells out, before any angle is applied: a picture's own four numbers,
  //: and a polyline's extent - which has no four numbers of its own - padded the way selection
  //: has always padded it. An angle is measured in this box, so the angle and this box together
  //: answer "where is the object drawn" without either having to be folded into the other. It is
  //: also what a turn must leave alone: an object that moved its own record while turning would
  //: creep across the canvas a little on every drag.
  function localBounds(object) {
    if (object.type === "image") return { x: object.x, y: object.y, width: object.width, height: object.height };
    var points = object.points || [], pad = Number(object.width) / 2 + 5;
    if (!points.length) return { x: 0, y: 0, width: 1, height: 1 };
    var left = points[0].x, right = left, top = points[0].y, bottom = top;
    for (var index = 1; index < points.length; index += 1) {
      var point = points[index];
      if (point.x < left) left = point.x; if (point.x > right) right = point.x;
      if (point.y < top) top = point.y; if (point.y > bottom) bottom = point.y;
    }
    return { x: left - pad, y: top - pad, width: Math.max(1, right - left + pad * 2), height: Math.max(1, bottom - top + pad * 2) };
  }
  //: The centre an angle is applied about when the record does not name one: the object's own
  //: centre, which is what an object turned on its own has always meant. This is the centre of the
  //: object's *own* angle only - a container's turn is about the container's centre, and it is the
  //: container that names it, never this.
  function spinPivotOf(object) { return rotationPivotOf(object) || boxCentre(localBounds(object)); }
  //: The member as it is drawn *inside* its container: its own angle applied, the container's turn
  //: not. A container has to hold its contents, and a member turned on its own leans out of the box
  //: its record spells - so the contents are measured with that lean included.
  function contentBounds(object) {
    return boxOfMap(levelMap(object), localBounds(object));
  }
  //: What is really drawn: the contents carried round by the container's turn. With no container -
  //: every object that has never been in a turned group, and every object there has ever been
  //: before this existed - the container's turn is zero and this is the box it always was.
  function bounds(object) {
    return boxOfMap(placedMap(object), localBounds(object));
  }
  //: The groups a document carries: one entry per container. A container's turn and size are written
  //: down once, on the container, and the members only name it. That is the whole difference between
  //: transforming a container and transforming its members.
  function groupsTable() { return app.state && app.state.groups ? app.state.groups : null; }
  function groupNode(groupId) { var table = groupsTable(); return table && groupId ? table[groupId] || null : null; }
  //: A member's own placement: what it is drawn as inside whatever container holds it. A record
  //: written before a placement was a matrix spells a turn about a centre, and a record written
  //: with a matrix is read as it stands - so an ordinary object keeps the record it always had.
  function levelMap(object) {
    var linear = object && object.linear;
    if (linear && Number.isFinite(Number(linear[0])) && Number.isFinite(Number(linear[1])) && Number.isFinite(Number(linear[2])) && Number.isFinite(Number(linear[3]))) {
      var offset = object.offset || {};
      return [Number(linear[0]), Number(linear[1]), Number(linear[2]), Number(linear[3]), Number(offset.x) || 0, Number(offset.y) || 0];
    }
    var angle = rotationOf(object);
    return angle ? fromRotation(angle, spinPivotOf(object)) : identity;
  }
  //: The container's placement, read off the container. A record written before containers were nodes
  //: carries the container's turn and centre on each member instead, and is read that way.
  function containerMap(object) {
    var node = object ? groupNode(object.groupId) : null;
    if (node && node.m) return node.m;
    var angle = groupRotationOf(object), pivot = groupPivotOf(object);
    return angle && pivot ? fromRotation(angle, pivot) : null;
  }
  //: Where a member is really drawn: its own placement and then its container's.
  function placedMap(object) {
    var container = containerMap(object);
    return container ? compose(container, levelMap(object)) : levelMap(object);
  }
  //: The one container a selection is inside, when every member is inside the same one. Read off the
  //: container itself - its own rectangle and its own placement - because a container is a thing with
  //: a size and an angle of its own: the box the handles ride is the container's own box, not a
  //: rectangle measured afresh from whatever happens to be inside it.
  function sharedContainer(objects) {
    if (!objects || !objects.length) return null;
    var id = objects[0].groupId;
    if (!id) return null;
    for (var index = 1; index < objects.length; index += 1) { if (objects[index].groupId !== id) return null; }
    var node = groupNode(id);
    return node && node.m && node.rect ? node : null;
  }
  //: A container table, copied. The containers belong beside the objects in everything that carries
  //: a drawing around - a journal entry, a saved record - because a member only *names* its
  //: container and cannot say where it is drawn without it: an entry that kept the members and lost
  //: the table would put a turned group away and bring it back upright.
  function cloneGroups(table) {
    var output = {};
    Object.keys(table || {}).forEach(function (id) {
      var node = table[id]; if (!node) return;
      var rect = node.rect || {};
      output[id] = { m: (node.m || identity).slice(),
        rect: { x: Number(rect.x) || 0, y: Number(rect.y) || 0, width: Math.max(1, Number(rect.width) || 1), height: Math.max(1, Number(rect.height) || 1) },
        formal: Boolean(node.formal) };
    });
    return output;
  }
  //: The rectangle a container holds, measured from its members: the tightest box around what they
  //: look like *inside* the container - each member's own placement applied, the container's not -
  //: because the container's placement is what carries that rectangle into the drawing. It is how a
  //: container inherited from an older record, which named no rectangle at all, gets one.
  function measureContainer(members) {
    var box = null;
    (members || []).forEach(function (object) {
      cornersOf(levelMap(object), localBounds(object)).forEach(function (point) {
        if (!box) { box = { left: point.x, top: point.y, right: point.x, bottom: point.y }; return; }
        if (point.x < box.left) box.left = point.x; if (point.x > box.right) box.right = point.x;
        if (point.y < box.top) box.top = point.y; if (point.y > box.bottom) box.bottom = point.y;
      });
    });
    var edges = box || { left: 0, top: 0, right: 1, bottom: 1 };
    return { x: edges.left, y: edges.top, width: Math.max(1, edges.right - edges.left), height: Math.max(1, edges.bottom - edges.top) };
  }
  //: The containers a record written before containers were nodes has instead of a table: the
  //: members still carry the group's turn and centre inside them, and the group they name is a group
  //: the user made - nothing else used to write a name down. They are handed back as a table so that
  //: a document saved by an older version opens as one this version can read, with the group it had
  //: rather than the members silently set loose.
  function groupsFromMembers(objects) {
    var output = {};
    (objects || []).forEach(function (object) {
      var id = object && object.groupId; if (!id || output[id]) return;
      var members = objects.filter(function (item) { return item.groupId === id; });
      var angle = groupRotationOf(object), pivot = groupPivotOf(object);
      output[id] = { m: angle && pivot ? fromRotation(angle, pivot) : identity, rect: measureContainer(members), formal: true };
    });
    return output;
  }
  function selectionBounds(objects, resolveBounds) {
    if (!objects || !objects.length) return null;
    var first = (resolveBounds || bounds)(objects[0]), left = first.x, top = first.y, right = first.x + first.width, bottom = first.y + first.height;
    for (var index = 1; index < objects.length; index += 1) {
      var box = (resolveBounds || bounds)(objects[index]);
      if (box.x < left) left = box.x; if (box.y < top) top = box.y;
      if (box.x + box.width > right) right = box.x + box.width;
      if (box.y + box.height > bottom) bottom = box.y + box.height;
    }
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }
  function estimateWeight(objects) {
    var weight = 64;
    (objects || []).forEach(function (object) { weight += 256 + (object.points ? object.points.length * 20 : 0); });
    return weight;
  }

  app.drawing = { cloneObject: cloneObject, cloneObjects: cloneObjects, storageObject: storageObject, bounds: bounds, selectionBounds: selectionBounds, estimateWeight: estimateWeight,
    rotationOf: rotationOf, normalizeAngle: normalizeAngle, boxCentre: boxCentre,
    rotationPivotOf: rotationPivotOf, spinPivotOf: spinPivotOf, localBounds: localBounds, turnedBox: turnedBox,
    groupRotationOf: groupRotationOf, groupPivotOf: groupPivotOf, contentBounds: contentBounds,
    placement: placement, levelMap: levelMap, containerMap: containerMap, placedMap: placedMap,
    groupNode: groupNode, sharedContainer: sharedContainer,
    cloneValue: cloneValue, cloneGroups: cloneGroups, groupsFromMembers: groupsFromMembers, measureContainer: measureContainer };
})(window.hamdraw);
