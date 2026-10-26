import base64
import uuid
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import text

try:
    from .database import (
        get_db, RosterUser, AuthSession, CourseClass,
        ExamItem, Enrollment, Submission, ScannerReview, hash_password, verify_password
    )
    from .omr_engine import grade_sheet_opencv
    from .scanner_batch import (
        canonical_student_id, derive_review_reasons,
        grade_answers, reconciled_breakdown
    )
except ImportError:
    from database import (
        get_db, RosterUser, AuthSession, CourseClass,
        ExamItem, Enrollment, Submission, hash_password, verify_password
    )
    from omr_engine import grade_sheet_opencv
    from scanner_batch import (
        canonical_student_id, derive_review_reasons,
        grade_answers, reconciled_breakdown
    )

app = FastAPI()

class ApiPayload(BaseModel):
    action: str
    sessionToken: Optional[str] = None
    studentId: Optional[str] = None
    password: Optional[str] = None
    newPassword: Optional[str] = None
    fullName: Optional[str] = None
    email: Optional[str] = None
    section: Optional[str] = None
    facultyData: Optional[Dict[str, Any]] = None
    facultyId: Optional[str] = None
    classId: Optional[str] = None
    classData: Optional[Dict[str, Any]] = None
    items: Optional[List[Dict[str, Any]]] = None
    testSet: Optional[str] = "A"
    base64Image: Optional[str] = None
    warpedBase64: Optional[str] = None
    answers: Optional[Dict[str, Any]] = None
    itemBreakdown: Optional[List[Dict[str, Any]]] = None
    submissionId: Optional[int] = None
    rawScore: Optional[int] = None
    percentage: Optional[float] = None
    isPassed: Optional[bool] = None
    studentIds: Optional[List[str]] = None
    studentsList: Optional[List[Dict[str, Any]]] = None
    batchMode: bool = False
    clientQrId: Optional[str] = None
    scanId: Optional[str] = None
    allowOverwrite: bool = False
    reviewDecision: Optional[str] = None
    reviewedStudentId: Optional[str] = None
    reviewedTestSet: Optional[str] = None
    reviewedAnswers: Optional[Dict[str, Any]] = None
    reviewConfirmed: bool = False
    reviewNote: Optional[str] = None

def validate_token(db: Session, token: Optional[str]):
    if not token:
        return None
    sess = db.query(AuthSession).filter_by(token=token).first()
    if not sess or sess.expires_at < datetime.utcnow():
        return None
    return db.query(RosterUser).filter_by(student_id=sess.student_id).first()

def can_scan_class(db, user, class_id):
    cls = db.query(CourseClass).filter_by(class_id=class_id).first()
    if not cls or (user.student_id.upper() != "FACULTY-01" and
                   cls.owner_teacher_id.upper() != user.student_id.upper()):
        return None
    return cls


def scanner_items(db, class_id):
    return db.query(ExamItem).filter_by(class_id=class_id).order_by(ExamItem.item_no.asc()).all()


def resolve_enrolled_student(db, class_id, student_id):
    sid = canonical_student_id(student_id)
    if not sid:
        return None
    student = db.query(RosterUser).filter(RosterUser.student_id.ilike(sid)).first()
    if not student or student.role == "TEACHER":
        return None
    enrollment = db.query(Enrollment).filter(
        Enrollment.class_id == class_id,
        Enrollment.student_id.ilike(sid)
    ).first()
    return student if enrollment else None


def save_scanner_grade(db, class_id, student, test_set, answers, image,
                       breakdown, allow_overwrite=False):
    """Single serialized grade write. Never overwrite silently, including on retries."""
    sid = canonical_student_id(student.student_id)
    db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
               {"key": f"ASPECT:{class_id}:{sid}"})
    existing = db.query(Submission).filter(
        Submission.class_id == class_id,
        Submission.student_id.ilike(sid)
    ).first()
    if existing and not allow_overwrite:
        return {"success": False, "duplicate": True,
                "message": "A grade already exists for this student and class. "
                           "Review the existing grade before choosing an explicit replacement."}
    score, total, answer_map, corrected = grade_answers(
        scanner_items(db, class_id), answers, test_set
    )
    cls = db.query(CourseClass).filter_by(class_id=class_id).first()
    pct = round(100 * score / total, 2) if total else 0.0
    passed = pct >= (cls.passing_percentage if cls else 70)
    record = existing
    if record is None:
        record = Submission(class_id=class_id, student_id=student.student_id)
        db.add(record)
    record.timestamp = datetime.utcnow()
    record.full_name = student.full_name
    record.section = student.section
    record.test_set = test_set
    record.raw_score = score
    record.total_points = total
    record.percentage = pct
    record.is_passed = passed
    record.answers = answer_map
    if image:
        record.scanned_image = image.split(",", 1)[-1] if image.startswith("data:") else image
    record.item_breakdown = reconciled_breakdown(breakdown, corrected)
    db.flush()
    return {"success": True, "studentId": student.student_id,
            "fullName": student.full_name, "rawScore": score,
            "totalPoints": total, "percentage": pct,
            "status": "PASSED" if passed else "FAILED",
            "replacedExisting": bool(existing)}


@app.get("/")
@app.get("/api")
@app.get("/api/{full_path:path}")
def api_health(full_path: str = ""):
    return {"success": True, "status": "ok", "service": "ASPECT Python OMR Engine"}

@app.post("/")
@app.post("/api")
@app.post("/api/{full_path:path}")
def handle_api(payload: ApiPayload, full_path: str = "", db: Session = Depends(get_db)):
    try:
        act = payload.action

        if act == "LOGIN":
            sid = (payload.studentId or "").strip().upper()
            pwd = (payload.password or "").strip()
            if not sid or not pwd:
                return {"success": False, "message": "ID and Password are required."}
            user = db.query(RosterUser).filter(RosterUser.student_id.ilike(sid)).first()
            if not user:
                if sid == "FACULTY-01":
                    user = RosterUser(
                        student_id="FACULTY-01",
                        email="faculty@filamer.edu.ph",
                        full_name="System Administrator",
                        section="College of Engineering",
                        role="TEACHER",
                        password_hash=hash_password("admin123"),
                        must_change_password=False
                    )
                    db.add(user)
                    db.commit()
                else:
                    return {"success": False, "message": f'ID "{sid}" is not registered.'}

            if not user.password_hash or "$" not in str(user.password_hash):
                default_pw = "admin123" if user.role == "TEACHER" else pwd
                user.password_hash = hash_password(default_pw)
                db.commit()

            if not verify_password(pwd, user.password_hash):
                if sid == "FACULTY-01" and pwd == "admin123":
                    user.password_hash = hash_password("admin123")
                    user.role = "TEACHER"
                    db.commit()
                else:
                    return {"success": False, "message": "Invalid password. Please try again."}

            session_token = str(uuid.uuid4())
            db.add(AuthSession(
                token=session_token,
                student_id=user.student_id,
                otp_code=None,
                expires_at=datetime.utcnow() + timedelta(hours=12)
            ))
            db.commit()
            return {
                "success": True,
                "sessionToken": session_token,
                "user": {
                    "studentId": user.student_id,
                    "email": user.email,
                    "fullName": user.full_name,
                    "section": user.section,
                    "role": user.role,
                    "mustChangePassword": bool(user.must_change_password)
                }
            }

        elif act == "REGISTER_STUDENT":
            sid = (payload.studentId or "").strip().upper()
            name = (payload.fullName or "").strip()
            sec = (payload.section or "").strip().upper()
            email = (payload.email or "").strip().lower()
            pwd = (payload.password or "").strip()

            if not sid or not name or not sec or not pwd:
                return {"success": False, "message": "Student ID, Full Name, Section, and Password are required."}
            if len(pwd) < 6:
                return {"success": False, "message": "Password must be at least 6 characters long."}

            existing = db.query(RosterUser).filter(RosterUser.student_id.ilike(sid)).first()
            if existing:
                return {"success": False, "message": f'ID "{sid}" is already registered. Please sign in instead.'}

            new_student = RosterUser(
                student_id=sid,
                email=email,
                full_name=name,
                section=sec,
                role="STUDENT",
                password_hash=hash_password(pwd),
                must_change_password=False
            )
            db.add(new_student)

            matching_classes = db.query(CourseClass).all()
            for c in matching_classes:
                if (c.default_section or "").strip().upper() == sec:
                    db.add(Enrollment(class_id=c.class_id, student_id=sid))

            session_token = str(uuid.uuid4())
            db.add(AuthSession(
                token=session_token,
                student_id=sid,
                otp_code=None,
                expires_at=datetime.utcnow() + timedelta(hours=12)
            ))
            db.commit()
            return {
                "success": True,
                "sessionToken": session_token,
                "user": {
                    "studentId": new_student.student_id,
                    "email": new_student.email,
                    "fullName": new_student.full_name,
                    "section": new_student.section,
                    "role": new_student.role,
                    "mustChangePassword": False
                }
            }

        elif act == "UPDATE_STUDENT_PROFILE":
            user = validate_token(db, payload.sessionToken)
            if not user or user.role != "STUDENT":
                return {"success": False, "message": "Unauthorized session."}

            name = (payload.fullName or "").strip()
            email = (payload.email or "").strip().lower()
            pwd = (payload.password or "").strip()

            if name: user.full_name = name
            if email is not None: user.email = email
            if pwd:
                if len(pwd) < 6:
                    return {"success": False, "message": "Password must be at least 6 characters."}
                user.password_hash = hash_password(pwd)
            db.commit()
            return {"success": True, "message": "Profile updated."}

        elif act == "CHANGE_PASSWORD":
            user = validate_token(db, payload.sessionToken)
            if not user:
                return {"success": False, "message": "Unauthorized session."}
            new_pw = (payload.newPassword or "").strip()
            if len(new_pw) < 6: return {"success": False, "message": "Password must be at least 6 characters long."}
            user.password_hash = hash_password(new_pw)
            user.must_change_password = False
            db.commit()
            return {"success": True, "message": "Password updated successfully."}

        elif act == "VALIDATE_SESSION":
            user = validate_token(db, payload.sessionToken)
            if not user:
                return {"valid": False}
            return {
                "valid": True,
                "user": {
                    "studentId": user.student_id,
                    "email": user.email,
                    "fullName": user.full_name,
                    "section": user.section,
                    "role": user.role,
                    "mustChangePassword": bool(user.must_change_password)
                }
            }

        elif act == "GET_STUDENT_RESULTS":
            user = validate_token(db, payload.sessionToken)
            if not user:
                return {"success": False, "message": "Invalid session."}
            subs = db.query(Submission).filter(Submission.student_id.ilike(user.student_id)).order_by(Submission.timestamp.desc()).all()
            classes = {c.class_id: c for c in db.query(CourseClass).all()}
            results = []
            for s in subs:
                c_meta = classes.get(s.class_id)
                results.append({
                    "id": s.id,
                    "classId": s.class_id,
                    "subjectCode": c_meta.subject_code if c_meta else s.class_id,
                    "subjectTitle": c_meta.subject_title if c_meta else "Course Exam",
                    "section": s.section,
                    "set": s.test_set,
                    "rawScore": s.raw_score,
                    "totalPoints": s.total_points,
                    "percentage": f"{s.percentage}%",
                    "timestamp": s.timestamp.strftime("%Y-%m-%d %H:%M"),
                    "status": "PASSED" if s.is_passed else "FAILED",
                    "scannedImage": s.scanned_image,
                    "itemBreakdown": s.item_breakdown
                })
            return {
                "success": True,
                "student": {
                    "studentId": user.student_id,
                    "fullName": user.full_name,
                    "section": user.section
                },
                "results": results
            }

        elif act == "GET_AVAILABLE_CLASSES":
            user = validate_token(db, payload.sessionToken)
            if not user or user.role != "STUDENT":
                return {"success": False, "message": "Unauthorized session."}
            all_classes = db.query(CourseClass).all()
            my_enrollments = {e.class_id for e in db.query(Enrollment).filter_by(student_id=user.student_id).all()}
            teachers = {t.student_id: t.full_name for t in db.query(RosterUser).filter_by(role="TEACHER").all()}
            
            res_classes = []
            for c in all_classes:
                res_classes.append({
                    "classId": c.class_id,
                    "subjectCode": c.subject_code,
                    "subjectTitle": c.subject_title,
                    "instructorName": teachers.get(c.owner_teacher_id, "Faculty"),
                    "isEnrolled": c.class_id in my_enrollments
                })
            return {"success": True, "classes": res_classes}

        elif act == "ENROLL_IN_CLASS":
            user = validate_token(db, payload.sessionToken)
            if not user or user.role != "STUDENT":
                return {"success": False, "message": "Unauthorized session."}
            if not payload.classId:
                return {"success": False, "message": "Class ID required."}
            existing = db.query(Enrollment).filter_by(class_id=payload.classId, student_id=user.student_id).first()
            if not existing:
                db.add(Enrollment(class_id=payload.classId, student_id=user.student_id))
                db.commit()
            return {"success": True, "message": "Successfully enrolled."}

        elif act == "UNENROLL_CLASS":
            user = validate_token(db, payload.sessionToken)
            if not user or user.role != "STUDENT":
                return {"success": False, "message": "Unauthorized session."}
            db.query(Enrollment).filter_by(class_id=payload.classId, student_id=user.student_id).delete()
            db.commit()
            return {"success": True, "message": "Successfully unenrolled."}

        # --- TEACHER / SYSTEM ADMIN ENDPOINTS BELOW ---
        user = validate_token(db, payload.sessionToken)
        if not user or user.role != "TEACHER":
            return {"success": False, "message": "Unauthorized teacher session."}

        if act == "GET_CLASSES":
            if user.student_id.upper() == "FACULTY-01":
                classes = db.query(CourseClass).all()
            else:
                classes = db.query(CourseClass).filter_by(owner_teacher_id=user.student_id).all()
            res_list = []
            for c in classes:
                cnt = db.query(ExamItem).filter_by(class_id=c.class_id).count()
                res_list.append({
                    "classId": c.class_id,
                    "subjectCode": c.subject_code,
                    "subjectTitle": c.subject_title,
                    "defaultSection": c.default_section,
                    "section": c.default_section,
                    "passingPercentage": c.passing_percentage,
                    "totalItems": cnt or 50
                })
            return {"success": True, "classes": res_list}

        elif act == "SAVE_CLASS":
            cd = payload.classData or {}
            cid = cd.get("classId") or f"CLS-{uuid.uuid4().hex[:5].upper()}"
            existing = db.query(CourseClass).filter_by(class_id=cid).first()
            if existing:
                existing.subject_code = cd.get("subjectCode", existing.subject_code)
                existing.subject_title = cd.get("subjectTitle", existing.subject_title)
                existing.default_section = cd.get("defaultSection") or cd.get("section") or existing.default_section
                existing.passing_percentage = int(cd.get("passingPercentage", 70))
            else:
                db.add(CourseClass(
                    class_id=cid,
                    subject_code=cd.get("subjectCode", "NEW 101"),
                    subject_title=cd.get("subjectTitle", "Untitled Subject"),
                    default_section=cd.get("defaultSection") or cd.get("section") or "BS-ECE",
                    passing_percentage=int(cd.get("passingPercentage", 70)),
                    owner_teacher_id=user.student_id
                ))
            db.commit()
            return {"success": True, "classId": cid}

        elif act == "GET_FULL_EXAM_CONFIG":
            items = db.query(ExamItem).filter_by(class_id=payload.classId).order_by(ExamItem.item_no.asc()).all()
            return {
                "success": True,
                "classId": payload.classId,
                "items": [
                    {
                        "itemNo": it.item_no,
                        "type": it.type,
                        "points": it.points,
                        "setA": it.set_a,
                        "setB": it.set_b
                    } for it in items
                ]
            }

        elif act == "SAVE_EXAM_CONFIG":
            db.query(ExamItem).filter_by(class_id=payload.classId).delete()
            for idx, it in enumerate(payload.items or []):
                db.add(ExamItem(
                    class_id=payload.classId,
                    item_no=idx + 1,
                    type=str(it.get("type", "MCQ")).upper(),
                    points=int(it.get("points", 1)),
                    set_a=str(it.get("setA", "A")).upper(),
                    set_b=str(it.get("setB", "A")).upper()
                ))
            db.commit()
            return {"success": True}

        elif act == "GET_CLASS_ENROLLMENTS":
            students = db.query(RosterUser).filter(RosterUser.role != "TEACHER").order_by(RosterUser.full_name.asc()).all()
            enrolled_ids = {
                e.student_id.upper()
                for e in db.query(Enrollment).filter_by(class_id=payload.classId).all()
            }
            enrolled, available = [], []
            for s in students:
                s_dict = {"studentId": s.student_id, "fullName": s.full_name, "section": s.section}
                if s.student_id.upper() in enrolled_ids:
                    enrolled.append(s_dict)
                else:
                    available.append(s_dict)
            return {"success": True, "enrolledStudents": enrolled, "availableStudents": available}

        elif act in ["ASSIGN_STUDENTS", "ASSIGN_STUDENTS_TO_CLASS"]:
            existing = {
                e.student_id.upper()
                for e in db.query(Enrollment).filter_by(class_id=payload.classId).all()
            }
            for sid in (payload.studentIds or []):
                if sid.upper() not in existing:
                    db.add(Enrollment(class_id=payload.classId, student_id=sid))
            db.commit()
            return {"success": True}

        elif act == "AUTO_ASSIGN_SECTION":
            sec = (payload.section or "").strip().upper()
            matching = db.query(RosterUser).filter(RosterUser.role != "TEACHER").all()
            existing = {
                e.student_id.upper()
                for e in db.query(Enrollment).filter_by(class_id=payload.classId).all()
            }
            for s in matching:
                if s.section.strip().upper() == sec and s.student_id.upper() not in existing:
                    db.add(Enrollment(class_id=payload.classId, student_id=s.student_id))
            db.commit()
            return {"success": True}

        elif act == "UNASSIGN_STUDENT":
            db.query(Enrollment).filter_by(class_id=payload.classId, student_id=payload.studentId).delete()
            db.commit()
            return {"success": True}

        elif act == "BATCH_IMPORT_STUDENTS":
            st_list = payload.studentsList or []
            if not st_list:
                return {"success": False, "message": "No valid records provided."}
            added, updated = 0, 0
            default_pw = "student123"
            default_hash = hash_password(default_pw)
            classes = db.query(CourseClass).all()

            for s in st_list:
                sid = str(s.get("studentId", "")).strip().upper()
                name = str(s.get("fullName", "")).strip()
                sec = str(s.get("section", "BS-ECE")).strip().upper()
                email = str(s.get("email", "")).strip().lower()

                if not sid or not name: continue

                existing = db.query(RosterUser).filter(RosterUser.student_id.ilike(sid)).first()
                if existing:
                    existing.full_name = name
                    existing.section = sec
                    if email: existing.email = email
                    if not existing.password_hash:
                        existing.password_hash = default_hash
                        existing.must_change_password = True
                    updated += 1
                else:
                    new_user = RosterUser(
                        student_id=sid, email=email, full_name=name, section=sec,
                        role="STUDENT", password_hash=default_hash, must_change_password=True
                    )
                    db.add(new_user)
                    added += 1

                for c in classes:
                    if (c.default_section or "").strip().upper() == sec:
                        enr = db.query(Enrollment).filter_by(class_id=c.class_id, student_id=sid).first()
                        if not enr:
                            db.add(Enrollment(class_id=c.class_id, student_id=sid))
            db.commit()
            return {"success": True, "message": f"Import complete: {added} new students added, {updated} updated. Default password is 'student123'."}

        elif act == "AI_VISION_GRADE":
            cls = can_scan_class(db, user, payload.classId)
            if not cls:
                return {"success": False, "message": "Class not found or not assigned to you."}
            db_items = scanner_items(db, payload.classId)
            if not db_items or len(db_items) > 100:
                return {"success": False, "message": "Set a valid 1–100 item answer key before scanning."}
            if not payload.base64Image:
                return {"success": False, "message": "No answer-sheet image was received."}
            encoded = payload.base64Image.split(",", 1)[-1]
            img_bytes = base64.b64decode(encoded, validate=True)
            if len(img_bytes) > 12 * 1024 * 1024:
                return {"success": False, "message": "Captured image is too large."}
            items = [{"itemNo": i.item_no, "type": i.type, "points": i.points,
                      "setA": i.set_a, "setB": i.set_b} for i in db_items]
            (detected_answers, raw_score, total_points, breakdown,
             detected_qr_id, warped_b64, detected_set, metadata) = grade_sheet_opencv(
                img_bytes, items, payload.testSet, return_metadata=True
            )
            qr_id = canonical_student_id(detected_qr_id)
            student = db.query(RosterUser).filter(RosterUser.student_id.ilike(qr_id)).first() if qr_id else None
            enrolled = bool(student and resolve_enrolled_student(db, payload.classId, qr_id))
            duplicate = bool(qr_id and db.query(Submission).filter(
                Submission.class_id == payload.classId,
                Submission.student_id.ilike(qr_id)
            ).first())
            reasons = derive_review_reasons(
                breakdown, qr_id, metadata["setMarkDetected"],
                browser_qr_id=payload.clientQrId,
                known_student=bool(student and student.role != "TEACHER"),
                enrolled=enrolled, duplicate=duplicate
            )
            pct = round(100 * raw_score / total_points, 2) if total_points else 0.0
            passed = pct >= cls.passing_percentage
            scan_id = None
            if payload.batchMode:
                scan_id = str(uuid.uuid4())
                db.add(ScannerReview(
                    id=scan_id, class_id=payload.classId, teacher_id=user.student_id,
                    student_id=qr_id, detected_qr_id=qr_id,
                    test_set=detected_set, status="PENDING",
                    reasons=reasons, answers=detected_answers,
                    item_breakdown=breakdown, scanned_image=warped_b64,
                    raw_score=raw_score, total_points=total_points
                ))
                db.commit()
            return {
                "success": True,
                "studentId": qr_id or canonical_student_id(payload.studentId),
                "detectedQrId": qr_id,
                "setMarkDetected": metadata["setMarkDetected"],
                "detectedTestSet": detected_set,
                "warpedBase64": warped_b64,
                "answers": detected_answers,
                "rawScore": raw_score,
                "totalPoints": total_points,
                "percentage": pct,
                "isPassed": passed,
                "status": "PASSED" if passed else "FAILED",
                "itemBreakdown": breakdown,
                "scanId": scan_id,
                "reviewReasons": reasons,
                "autoSaveEligible": bool(payload.batchMode and not reasons)
            }

        elif act == "SCANNER_SUBMIT":
            cls = can_scan_class(db, user, payload.classId)
            if not cls:
                return {"success": False, "message": "Class not found or not assigned to you."}
            job = None
            if payload.scanId:
                job = db.query(ScannerReview).filter_by(
                    id=payload.scanId, class_id=payload.classId,
                    teacher_id=user.student_id
                ).first()
                if not job:
                    return {"success": False, "message": "Scanned candidate not found."}
                if job.status == "SAVED":
                    return {"success": True, "alreadySaved": True,
                            "message": "This scan was already saved."}
                if job.status != "PENDING":
                    return {"success": False, "message": "This scan is no longer pending."}
                if job.reasons:
                    return {"success": False, "reviewRequired": True,
                            "message": "This scan needs manual review before saving."}
                sid = job.detected_qr_id
                key = job.test_set
                answers = job.answers
                preview = job.scanned_image
                breakdown = job.item_breakdown
                overwrite = False
            else:
                sid = payload.studentId
                key = (payload.testSet or "A").upper()
                answers = payload.answers
                preview = payload.warpedBase64 or ""
                breakdown = payload.itemBreakdown
                overwrite = bool(payload.allowOverwrite)
            student = resolve_enrolled_student(db, payload.classId, sid)
            if not student:
                return {"success": False, "message": "Student is not enrolled in this class."}
            result = save_scanner_grade(db, payload.classId, student, key,
                                        answers, preview, breakdown, overwrite)
            if result["success"]:
                if job:
                    job.status = "SAVED"
                    job.reviewed_at = datetime.utcnow()
                    job.reviewed_by = user.student_id
                db.commit()
            else:
                db.rollback()
            return result

        elif act == "GET_SCAN_REVIEW_QUEUE":
            if not can_scan_class(db, user, payload.classId):
                return {"success": False, "message": "Class not found or not assigned to you."}
            jobs = db.query(ScannerReview).filter_by(
                class_id=payload.classId, teacher_id=user.student_id,
                status="PENDING"
            ).order_by(ScannerReview.created_at.asc()).limit(250).all()
            return {"success": True, "pendingCount": len(jobs), "jobs": [
                {"scanId": j.id, "studentId": j.student_id, "testSet": j.test_set,
                 "rawScore": j.raw_score, "totalPoints": j.total_points,
                 "reasons": j.reasons or [],
                 "createdAt": j.created_at.strftime("%Y-%m-%d %H:%M:%S")}
                for j in jobs
            ]}

        elif act == "GET_SCAN_REVIEW_DETAIL":
            job = db.query(ScannerReview).filter_by(
                id=payload.scanId, teacher_id=user.student_id,
                class_id=payload.classId, status="PENDING"
            ).first()
            if not job or not can_scan_class(db, user, job.class_id):
                return {"success": False, "message": "Pending scan not found."}
            return {"success": True, "job": {
                "scanId": job.id, "studentId": job.student_id,
                "testSet": job.test_set, "answers": job.answers,
                "scannedImage": job.scanned_image,
                "itemBreakdown": job.item_breakdown, "reasons": job.reasons or [],
                "rawScore": job.raw_score, "totalPoints": job.total_points
            }}

        elif act == "REVIEW_SCAN":
            job = db.query(ScannerReview).filter_by(
                id=payload.scanId, class_id=payload.classId,
                teacher_id=user.student_id, status="PENDING"
            ).first()
            if not job or not can_scan_class(db, user, job.class_id):
                return {"success": False, "message": "Pending scan not found."}
            if payload.reviewDecision == "DISMISS":
                if not payload.reviewConfirmed:
                    return {"success": False, "message": "Confirm dismissal first."}
                job.status = "DISMISSED"
                job.reviewed_by = user.student_id
                job.reviewed_at = datetime.utcnow()
                job.review_note = (payload.reviewNote or "")[:500]
                db.commit()
                return {"success": True, "message": "Review scan dismissed. No grade was saved."}
            if payload.reviewDecision != "SAVE" or not payload.reviewConfirmed:
                return {"success": False, "message": "Confirm the reviewed answer sheet first."}
            sid = payload.reviewedStudentId or job.student_id
            student = resolve_enrolled_student(db, job.class_id, sid)
            if not student:
                return {"success": False, "message": "Choose an enrolled student before approving."}
            exam_set = (payload.reviewedTestSet or job.test_set).upper()
            answers = payload.reviewedAnswers if payload.reviewedAnswers is not None else job.answers
            result = save_scanner_grade(
                db, job.class_id, student, exam_set, answers,
                job.scanned_image, job.item_breakdown,
                bool(payload.allowOverwrite)
            )
            if result["success"]:
                job.status = "SAVED"
                job.student_id = canonical_student_id(student.student_id)
                job.test_set = exam_set
                job.reviewed_by = user.student_id
                job.reviewed_at = datetime.utcnow()
                job.review_note = (payload.reviewNote or "")[:500]
                db.commit()
            else:
                db.rollback()
            return result

        elif act == "UPDATE_SUBMISSION":
            sub = db.query(Submission).filter_by(id=payload.submissionId).first()
            if sub and not can_scan_class(db, user, sub.class_id):
                return {"success": False, "message": "Class not found or not assigned to you."}
            if not sub:
                return {"success": False, "message": "Submission record not found."}
            sub.raw_score = payload.rawScore
            sub.percentage = payload.percentage
            sub.is_passed = payload.isPassed
            if payload.answers:
                sub.answers = payload.answers
            db.commit()
            return {"success": True, "message": "Grade override applied successfully."}

        elif act == "GET_SUBMISSIONS":
            if not can_scan_class(db, user, payload.classId):
                return {"success": False, "message": "Class not found or not assigned to you."}
            subs = db.query(Submission).filter_by(class_id=payload.classId).order_by(Submission.timestamp.desc()).all()
            return {
                "success": True,
                "submissions": [
                    {
                        "id": s.id,
                        "fullName": s.full_name,
                        "studentId": s.student_id,
                        "testSet": s.test_set,
                        "set": s.test_set,
                        "rawScore": s.raw_score,
                        "totalPoints": s.total_points,
                        "percentage": f"{s.percentage}%",
                        "isPassed": s.is_passed,
                        "timestamp": s.timestamp.strftime("%Y-%m-%d %H:%M"),
                        "scannedImage": s.scanned_image,
                        "answers": s.answers,
                        "itemBreakdown": s.item_breakdown
                    } for s in subs
                ]
            }

        elif act == "GET_FACULTY":
            teachers = db.query(RosterUser).filter_by(role="TEACHER").order_by(RosterUser.student_id.asc()).all()
            return {"success": True, "faculty": [{"facultyId": t.student_id, "fullName": t.full_name, "email": t.email, "department": t.section} for t in teachers]}
        elif act == "REGISTER_FACULTY":
            fd = payload.facultyData or {}
            fid = (fd.get("facultyId") or "").strip().upper()
            fname = (fd.get("fullName") or "").strip()
            femail = (fd.get("email") or "").strip().lower()
            fdept = (fd.get("department") or "College of Engineering").strip()
            fpwd = (fd.get("password") or "").strip()
            if not fid or not fname or not fpwd: return {"success": False, "message": "Missing required fields."}
            existing = db.query(RosterUser).filter(RosterUser.student_id.ilike(fid)).first()
            if existing:
                existing.full_name = fname; existing.email = femail; existing.section = fdept; existing.role = "TEACHER"; existing.password_hash = hash_password(fpwd)
                db.commit()
                return {"success": True, "message": "Faculty account updated."}
            db.add(RosterUser(student_id=fid, email=femail, full_name=fname, section=fdept, role="TEACHER", password_hash=hash_password(fpwd)))
            db.commit()
            return {"success": True, "message": "Faculty account registered."}
        elif act == "DELETE_FACULTY":
            target_id = (payload.facultyId or "").strip().upper()
            if target_id in ["FACULTY-01", user.student_id.upper()]: return {"success": False, "message": "Cannot delete admin or self."}
            db.query(RosterUser).filter(RosterUser.student_id.ilike(target_id)).delete()
            db.commit()
            return {"success": True}

        return {"success": False, "message": f"Action '{act}' not supported."}
    except Exception as e:
        return {"success": False, "message": f"Backend error: {str(e)}"}