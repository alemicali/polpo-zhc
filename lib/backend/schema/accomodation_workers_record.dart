import 'dart:async';

import 'package:collection/collection.dart';

import '/backend/schema/util/firestore_util.dart';

import 'index.dart';
import '/flutter_flow/flutter_flow_util.dart';

class AccomodationWorkersRecord extends FirestoreRecord {
  AccomodationWorkersRecord._(
    DocumentReference reference,
    Map<String, dynamic> data,
  ) : super(reference, data) {
    _initializeFields();
  }

  // "accomodationName" field.
  String? _accomodationName;
  String get accomodationName => _accomodationName ?? '';
  bool hasAccomodationName() => _accomodationName != null;

  // "active" field.
  bool? _active;
  bool get active => _active ?? false;
  bool hasActive() => _active != null;

  // "startDate" field.
  DateTime? _startDate;
  DateTime? get startDate => _startDate;
  bool hasStartDate() => _startDate != null;

  // "endDate" field.
  DateTime? _endDate;
  DateTime? get endDate => _endDate;
  bool hasEndDate() => _endDate != null;

  // "worker" field.
  DocumentReference? _worker;
  DocumentReference? get worker => _worker;
  bool hasWorker() => _worker != null;

  // "address" field.
  String? _address;
  String get address => _address ?? '';
  bool hasAddress() => _address != null;

  // "accomodation" field.
  DocumentReference? _accomodation;
  DocumentReference? get accomodation => _accomodation;
  bool hasAccomodation() => _accomodation != null;

  void _initializeFields() {
    _accomodationName = snapshotData['accomodationName'] as String?;
    _active = snapshotData['active'] as bool?;
    _startDate = snapshotData['startDate'] as DateTime?;
    _endDate = snapshotData['endDate'] as DateTime?;
    _worker = snapshotData['worker'] as DocumentReference?;
    _address = snapshotData['address'] as String?;
    _accomodation = snapshotData['accomodation'] as DocumentReference?;
  }

  static CollectionReference get collection =>
      FirebaseFirestore.instance.collection('accomodationWorkers');

  static Stream<AccomodationWorkersRecord> getDocument(DocumentReference ref) =>
      ref.snapshots().map((s) => AccomodationWorkersRecord.fromSnapshot(s));

  static Future<AccomodationWorkersRecord> getDocumentOnce(
          DocumentReference ref) =>
      ref.get().then((s) => AccomodationWorkersRecord.fromSnapshot(s));

  static AccomodationWorkersRecord fromSnapshot(DocumentSnapshot snapshot) =>
      AccomodationWorkersRecord._(
        snapshot.reference,
        mapFromFirestore(snapshot.data() as Map<String, dynamic>),
      );

  static AccomodationWorkersRecord getDocumentFromData(
    Map<String, dynamic> data,
    DocumentReference reference,
  ) =>
      AccomodationWorkersRecord._(reference, mapFromFirestore(data));

  @override
  String toString() =>
      'AccomodationWorkersRecord(reference: ${reference.path}, data: $snapshotData)';

  @override
  int get hashCode => reference.path.hashCode;

  @override
  bool operator ==(other) =>
      other is AccomodationWorkersRecord &&
      reference.path.hashCode == other.reference.path.hashCode;
}

Map<String, dynamic> createAccomodationWorkersRecordData({
  String? accomodationName,
  bool? active,
  DateTime? startDate,
  DateTime? endDate,
  DocumentReference? worker,
  String? address,
  DocumentReference? accomodation,
}) {
  final firestoreData = mapToFirestore(
    <String, dynamic>{
      'accomodationName': accomodationName,
      'active': active,
      'startDate': startDate,
      'endDate': endDate,
      'worker': worker,
      'address': address,
      'accomodation': accomodation,
    }.withoutNulls,
  );

  return firestoreData;
}

class AccomodationWorkersRecordDocumentEquality
    implements Equality<AccomodationWorkersRecord> {
  const AccomodationWorkersRecordDocumentEquality();

  @override
  bool equals(AccomodationWorkersRecord? e1, AccomodationWorkersRecord? e2) {
    return e1?.accomodationName == e2?.accomodationName &&
        e1?.active == e2?.active &&
        e1?.startDate == e2?.startDate &&
        e1?.endDate == e2?.endDate &&
        e1?.worker == e2?.worker &&
        e1?.address == e2?.address &&
        e1?.accomodation == e2?.accomodation;
  }

  @override
  int hash(AccomodationWorkersRecord? e) => const ListEquality().hash([
        e?.accomodationName,
        e?.active,
        e?.startDate,
        e?.endDate,
        e?.worker,
        e?.address,
        e?.accomodation
      ]);

  @override
  bool isValidKey(Object? o) => o is AccomodationWorkersRecord;
}
